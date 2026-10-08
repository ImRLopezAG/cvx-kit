import { createAuthFunctions } from 'cvx-kit/auth'
import {
	createEffectCrud,
	createEffectFoundation,
	effectContract,
	effectTransactionalIdempotency,
	effectZodApiBuilder,
} from 'cvx-kit/effect'
import {
	captureIdempotencyInvocation,
	type IdempotencyCapture,
	type IdempotencyInvocation,
} from 'cvx-kit/idempotency'
import { Context, Effect } from 'effect'
import { v } from 'convex/values'
import { zid } from 'cvx-kit/zod-table'
import { z } from 'zod'
import type { GenericDatabaseWriter } from 'convex/server'
import type { DataModel, Id } from './_generated/dataModel'
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from './_generated/server'
import { idempotentNotes } from './schema'
import { baseVersions } from './idempotencyDeploymentConfig'

const operation = 'idempotentNotes.create'
const scopeOf = (tenant: string, principal: string) => JSON.stringify([tenant, principal])
const bounds = {
	maxDepth: 8,
	maxNodes: 100,
	maxBytes: 4096,
	maxArrayLength: 20,
	maxObjectFields: 20,
}
const auth = createAuthFunctions<DataModel, 'owner' | 'viewer'>({
	query,
	mutation,
	action,
	internalQuery,
	internalMutation,
	internalAction,
	getAuthUser: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity()
		return identity ? { id: identity.subject } : null
	},
	mapRole: (role) => (role === 'owner' || role === 'viewer' ? role : null),
	adminRoles: ['owner'],
	security: {
		tenancy: { tables: ['idempotentNotes', 'idempotentReceipts', 'idempotentAudits'] },
		rules: (bundle) => ({
			idempotentNotes: { insert: async () => bundle.role === 'owner' },
			idempotentReceipts: {
				insert: async () => bundle.role === 'owner',
				modify: async () => bundle.role === 'owner',
			},
			idempotentAudits: { insert: async () => bundle.role === 'owner' },
			idempotentPermissions: {
				read: async (_ctx, row) => row.scope === scopeOf(bundle.tenant, bundle.actor.userId),
			},
		}),
	},
})
type Mode = 'success' | 'audit' | 'completion' | 'result' | 'cleanup'
type Host = {
	db: GenericDatabaseWriter<DataModel>
	actor: { userId: string }
	tenant: string
	role: string | null
	invocation: IdempotencyInvocation
	key: string
	scope: string
	mode: Mode
}
class Writer extends Context.Service<Writer, Host>()('NativeIdempotencyWriter') {}
const finalResult = z.object({ id: zid('idempotentNotes'), title: z.string() }).strict()
const finalWire = z.object({ version: z.literal(1), value: finalResult }).strict()
const replayResult = effectContract<z.input<typeof finalWire>, z.output<typeof finalResult>, Error>(
	(wire) =>
		Effect.suspend(() => {
			const parsed = finalWire.safeParse(wire)
			return parsed.success
				? Effect.succeed(parsed.data.value)
				: Effect.fail(new Error('IDEMPOTENCY_WIRE'))
		}),
)
const capability = effectTransactionalIdempotency({
	final: {
		replayResult,
		encode: (result: z.output<typeof finalResult>) => ({ version: 1 as const, value: result }),
	},
	fingerprint: (canonical: string) => canonical,
	authorize: () =>
		Effect.gen(function* () {
			const host = yield* Writer
			const permission = yield* Effect.promise(() =>
				host.db
					.query('idempotentPermissions')
					.withIndex('by_scope', (q) => q.eq('scope', host.scope))
					.unique(),
			)
			if (host.role !== 'owner' || permission?.allowed === false)
				return yield* Effect.fail(new Error('IDEMPOTENCY_DENIED'))
		}),
	lookup: (identity) =>
		Effect.gen(function* () {
			const host = yield* Writer
			return yield* Effect.promise(() =>
				host.db
					.query('idempotentReceipts')
					.withIndex('by_identity', (q) =>
						q
							.eq('operation', identity.operation)
							.eq('scope', identity.scope)
							.eq('key', identity.key),
					)
					.take(2),
			)
		}),
	claim: (identity, receipt) =>
		Effect.gen(function* () {
			const host = yield* Writer
			return yield* Effect.promise(() =>
				host.db.insert('idempotentReceipts', {
					tenant: host.tenant,
					...identity,
					versions: receipt.versions,
					fingerprint: receipt.fingerprint,
					state: 'pending',
				}),
			)
		}),
	complete: (id: Id<'idempotentReceipts'>, receipt) =>
		Effect.gen(function* () {
			const host = yield* Writer
			const wire = finalWire.parse(receipt.result)
			yield* Effect.promise(() => host.db.patch(id, { state: 'completed', result: wire }))
			if (host.mode === 'completion') return yield* Effect.fail(new Error('IDEMPOTENCY_COMPLETION'))
		}),
})
const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'IDEMPOTENCY_FAILURE' }),
	},
	writeAudit: (host: Host, entry) =>
		Effect.gen(function* () {
			yield* Effect.promise(() =>
				host.db.insert('idempotentAudits', {
					tenant: host.tenant,
					scope: host.scope,
					key: host.key,
					id: zid('idempotentNotes').parse(entry.aggregate.id),
					operation: entry.operation,
				}),
			)
			if (host.mode === 'audit') return yield* Effect.fail(new Error('IDEMPOTENCY_AUDIT'))
		}),
})
const crud = createEffectCrud({
	foundation,
	table: idempotentNotes,
	context: (host: Host) => host,
	aggregateType: 'idempotent-note',
	actor: (host) => host.actor.userId,
	enrich: (host) => ({ tenant: host.tenant, scope: host.scope, key: host.key }),
	read: {
		maxPageSize: 2,
		project: (row) => ({ title: row.title }),
		get: (host, id) => host.db.get(id),
		list: (host, options) =>
			host.db
				.query('idempotentNotes')
				.withIndex('by_scope_key', (q) => q.eq('scope', host.scope))
				.paginate(options),
	},
})
const commands = foundation.Command({
	context: (host: Host) => host,
	operations: ({ command }) => ({
		create: command({
			input: z.object({ title: z.string().trim().toLowerCase() }).strict(),
			result: finalResult
				.refine((value) => value.title !== 'INVALID', { message: 'IDEMPOTENCY_RESULT' })
				.transform((value) => ({ ...value, title: `${value.title}!` })),
			replayResult: capability.replayResult,
			classification: 'business',
			prepare: (host) => capability.prepare(host.invocation),
			handler: (input, host) =>
				Effect.gen(function* () {
					if (host.mode === 'cleanup')
						yield* Effect.acquireRelease(Effect.succeed(null), () =>
							Effect.die(new Error('IDEMPOTENCY_CLEANUP')),
						)
					const created = yield* crud.commands.exec('idempotentNotes.create', input, host)
					return { id: created.id, title: host.mode === 'result' ? 'INVALID' : input.title }
				}),
			// The nested generated CRUD operation owns the single execution audit.
			audit: () => null,
		}),
	}),
})
const securedMutation = effectZodApiBuilder(auth.authMutation, { services: () => Context.empty() })
export const nativeIdempotencyOperation = commands.expose(Symbol('idempotentNotes'), 'create')
export const save = securedMutation({
	args: {
		key: z.string(),
		payload: z.object({ title: z.string() }).strict(),
		normalized: z.boolean().optional(),
		mode: z.enum(['success', 'audit', 'completion', 'result', 'cleanup']).optional(),
	},
	returns: finalResult,
	handler: (ctx, args) => {
		const scope = scopeOf(ctx.tenant, ctx.actor.userId)
		// SAFETY: Canonical normalization accepts untrusted wire data and validates it here.
		// oxlint-disable-next-line anti-slop/no-unknown-parameters
		const normalize = (raw: unknown) => {
			const input = z.object({ title: z.string() }).parse(raw)
			return { title: input.title.trim().toLowerCase() }
		}
		const canonical: IdempotencyCapture['canonical'] = args.normalized
			? { bounds, normalize }
			: { bounds }
		const invocation = captureIdempotencyInvocation({
			binding: { kind: 'mutation', atomicity: 'same-mutation' },
			identity: { operation, scope, key: args.key },
			versions: {
				...baseVersions,
				fingerprintPolicy: args.normalized ? 'normalized-1' : baseVersions.fingerprintPolicy,
			},
			rawInput: args.payload,
			canonical,
		})
		const host: Host = { ...ctx, scope, key: args.key, mode: args.mode ?? 'success', invocation }
		return commands.exec('create', args.payload, host).pipe(
			Effect.provideService(Writer, host),
			Effect.catchTag('IdempotencyError', (error) =>
				Effect.fail(new Error(`IDEMPOTENCY_${error.code}`)),
			),
		)
	},
})
const fixtureScope = scopeOf('idem-tenant', 'idem-owner')
export const authorize = internalMutation({
	args: { allowed: v.boolean() },
	returns: v.null(),
	handler: async (ctx, { allowed }) => {
		const current = await ctx.db
			.query('idempotentPermissions')
			.withIndex('by_scope', (q) => q.eq('scope', fixtureScope))
			.unique()
		if (current) await ctx.db.patch(current._id, { allowed })
		else await ctx.db.insert('idempotentPermissions', { scope: fixtureScope, allowed })
		return null
	},
})
export const alterReceipt = internalMutation({
	args: {
		key: v.string(),
		version: v.optional(
			v.union(
				v.literal('operation'),
				v.literal('contract'),
				v.literal('binding'),
				v.literal('fingerprintPolicy'),
			),
		),
		restore: v.optional(v.boolean()),
		corruption: v.optional(
			v.union(v.literal('result'), v.literal('duplicate'), v.literal('pending')),
		),
		expire: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('idempotentReceipts')
			.withIndex('by_identity', (q) =>
				q.eq('operation', operation).eq('scope', fixtureScope).eq('key', args.key),
			)
			.take(2)
		if (rows.length !== 1) throw new Error('IDEMPOTENCY_FIXTURE_RECEIPT')
		const row = rows[0]
		if (args.expire) await ctx.db.delete(row._id)
		else if (args.restore) await ctx.db.patch(row._id, { versions: baseVersions })
		else if (args.version)
			await ctx.db.patch(row._id, {
				versions: { ...row.versions, [args.version]: 'stale-fixture' },
			})
		else if (args.corruption === 'result') await ctx.db.patch(row._id, { result: { broken: true } })
		else if (args.corruption === 'pending') await ctx.db.patch(row._id, { state: 'pending' })
		else if (args.corruption === 'duplicate') {
			const { _id, _creationTime, ...copy } = row
			void _id
			void _creationTime
			await ctx.db.insert('idempotentReceipts', copy)
		}
		return null
	},
})
export const state = internalQuery({
	args: { key: v.string(), tenant: v.string(), principal: v.string() },
	returns: v.object({
		business: v.array(v.any()),
		audits: v.array(v.any()),
		receipts: v.array(v.any()),
	}),
	handler: async (ctx, args) => {
		const scope = scopeOf(args.tenant, args.principal)
		const business = await ctx.db
			.query('idempotentNotes')
			.withIndex('by_scope_key', (q) => q.eq('scope', scope).eq('key', args.key))
			.take(20)
		const audits = await ctx.db
			.query('idempotentAudits')
			.withIndex('by_scope_key', (q) => q.eq('scope', scope).eq('key', args.key))
			.take(20)
		const receipts = await ctx.db
			.query('idempotentReceipts')
			.withIndex('by_identity', (q) =>
				q.eq('operation', operation).eq('scope', scope).eq('key', args.key),
			)
			.take(20)
		return { business, audits, receipts }
	},
})
export const unsupported = action({
	args: {},
	returns: v.null(),
	handler: async () => {
		try {
			captureIdempotencyInvocation({
				// SAFETY: Deliberately exercise runtime rejection of an erased unsupported binding.
				// oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening
				binding: { kind: 'action', atomicity: 'external-store' } as unknown as {
					kind: 'mutation'
					atomicity: 'same-mutation'
				},
				identity: { operation, scope: fixtureScope, key: 'unsupported' },
				versions: baseVersions,
				rawInput: { title: 'unsupported' },
				canonical: { bounds },
			})
		} catch (error) {
			if (error instanceof Error && 'code' in error)
				throw new Error(`IDEMPOTENCY_${String(error.code)}`)
			throw error
		}
		return null
	},
})
