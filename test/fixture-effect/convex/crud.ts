import { createAuthFunctions } from 'cvx-kit/auth'
import { createTriggers, tenantOwnership } from 'cvx-kit/triggers'
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from './_generated/server'
import type { DataModel } from './_generated/dataModel'
import { v } from 'convex/values'
import { createEffectCrud, createEffectFoundation, effectZodApiBuilder } from 'cvx-kit/effect'
import { paginated, zid } from 'cvx-kit/zod-table'
import { Context, Effect } from 'effect'
import { z } from 'zod'
import type { GenericDatabaseReader, GenericDatabaseWriter } from 'convex/server'
import { crudNotes } from './schema'

const triggers = createTriggers<DataModel>()
tenantOwnership(triggers, 'crudNotes')
triggers.register('crudNotes', async (ctx, change) => {
	await ctx.innerDb.insert('crudHistory', { id: change.id, operation: change.operation })
})

const auth = createAuthFunctions<DataModel, 'owner' | 'viewer'>({
	triggers,
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
	mapRole: (slug) => (slug === 'owner' || slug === 'viewer' ? slug : null),
	adminRoles: ['owner'],
	security: {
		tenancy: { tables: ['crudNotes', 'crudOthers'] },
		rules: (bundle) => ({
			crudNotes: {
				insert: async () => bundle.role === 'owner',
				modify: async () => bundle.role === 'owner',
			},
			crudOthers: {
				insert: async () => bundle.role === 'owner',
				modify: async () => bundle.role === 'owner',
			},
			crudAudits: { insert: async () => true },
		}),
	},
})

type CrudHost = {
	db: GenericDatabaseReader<DataModel>
	actor: { userId: string }
	tenant: string
	failAudit?: boolean
}
class CrudWriter extends Context.Service<CrudWriter, GenericDatabaseWriter<DataModel>>()(
	'NativeCrudWriter',
) {}
const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'CRUD_FAILURE' }),
	},
	writeAudit: (host: CrudHost, entry) =>
		Effect.gen(function* () {
			const db = yield* CrudWriter
			yield* Effect.promise(() =>
				db.insert('crudAudits', {
					operation: entry.operation,
					actor: entry.actorId,
					id: entry.aggregate.id,
				}),
			)
			if (host.failAudit) return yield* Effect.fail(new Error('CRUD_AUDIT_FAILURE'))
		}),
})
const crud = createEffectCrud({
	foundation,
	table: crudNotes,
	context: (host: CrudHost) => host,
	aggregateType: 'note',
	actor: (host) => host.actor.userId,
	enrich: (host) => ({ tenant: host.tenant, owner: host.actor.userId, secret: 'server-private' }),
	repository: {
		insert: (_host, values) =>
			Effect.gen(function* () {
				const db = yield* CrudWriter
				return yield* Effect.promise(() => db.insert('crudNotes', values))
			}),
		patch: (_host, id, values) =>
			Effect.gen(function* () {
				const db = yield* CrudWriter
				yield* Effect.promise(() => db.patch(id, values))
			}),
	},
	read: {
		maxPageSize: 2,
		maximumRowsRead: 4,
		// Return raw public fields; the generated query result contract owns decoding.
		project: (row) => ({ title: row.title }),
		get: (host, id) => host.db.get(id),
		list: (host, options) =>
			host.db
				.query('crudNotes')
				.withIndex('by_tenant', (q) => q.eq('tenant', host.tenant))
				.order('desc')
				.paginate(options),
	},
})
const securedMutation = effectZodApiBuilder(auth.authMutation, {
	services: (ctx) => Context.make(CrudWriter, ctx.db),
})
const securedQuery = effectZodApiBuilder(auth.authQuery, { services: () => Context.empty() })

// String bindings exercise the domain executor's table check independently of native zid.
export const createOther = securedMutation({
	args: {},
	returns: zid('crudOthers'),
	handler: (ctx) =>
		ctx.db.insert('crudOthers', {
			title: 'other-table',
			secret: 'other-private',
			owner: ctx.actor.userId,
			tenant: ctx.tenant,
		}),
})
export const getFromString = securedQuery({
	args: { id: z.string() },
	returns: crudNotes.publicDto.nullable(),
	handler: (ctx, args) => crud.queries.exec('crudNotes.get', args, ctx),
})
export const updateFromString = securedMutation({
	args: { id: z.string(), data: crudNotes.commandInput.partial().strict() },
	returns: z.object({ ok: z.literal(true) }),
	handler: (ctx, args) => crud.commands.exec('crudNotes.update', args, ctx),
})
export const archiveFromString = securedMutation({
	args: { id: z.string() },
	returns: z.object({ ok: z.literal(true) }),
	handler: (ctx, args) => crud.commands.exec('crudNotes.archive', args, ctx),
})
export const otherState = internalQuery({
	args: { id: v.id('crudOthers') },
	returns: v.object({
		title: v.string(),
		archivedAt: v.optional(v.number()),
		audits: v.array(v.string()),
	}),
	handler: async (ctx, { id }) => {
		const row = await ctx.db.get(id)
		if (!row) throw new Error('MISSING_OTHER_FIXTURE')
		const audits = await ctx.db
			.query('crudAudits')
			.withIndex('by_note', (q) => q.eq('id', id))
			.take(20)
		type OtherState = { title: string; archivedAt?: number; audits: string[] }
		const state: OtherState = {
			title: row.title,
			audits: audits.map((entry) => entry.operation),
		}
		if (row.archivedAt !== undefined) state.archivedAt = row.archivedAt
		return state
	},
})

export const create = securedMutation({
	args: { title: z.string(), failAudit: z.boolean().optional() },
	returns: z.object({ id: zid('crudNotes') }),
	handler: (ctx, args) =>
		crud.commands.exec(
			'crudNotes.create',
			{ title: args.title },
			{ ...ctx, failAudit: args.failAudit },
		),
})
export const update = securedMutation({
	args: {
		id: zid('crudNotes'),
		data: crudNotes.commandInput.partial().strict(),
		failAudit: z.boolean().optional(),
	},
	returns: z.object({ ok: z.literal(true) }),
	handler: (ctx, args) =>
		crud.commands.exec(
			'crudNotes.update',
			{ id: args.id, data: args.data },
			{ ...ctx, failAudit: args.failAudit },
		),
})
export const archive = securedMutation({
	args: { id: zid('crudNotes') },
	returns: z.object({ ok: z.literal(true) }),
	handler: (ctx, args) => crud.commands.exec('crudNotes.archive', args, ctx),
})
export const get = securedQuery({
	args: { id: zid('crudNotes') },
	returns: crudNotes.publicDto.nullable(),
	handler: (ctx, args) => crud.queries.exec('crudNotes.get', args, ctx),
})
const nativePagination = paginated(crudNotes.publicDto)
export const list = securedQuery({
	args: { numItems: z.number(), cursor: z.string().nullable() },
	returns: nativePagination.result,
	handler: (ctx, args) => crud.queries.exec('crudNotes.list', args, ctx),
})
export const listPaginated = securedQuery({
	args: nativePagination.args,
	returns: nativePagination.result,
	handler: (ctx, args) => crud.queries.exec('crudNotes.list', args.paginationOpts, ctx),
})
export const invalidOutput = securedMutation({
	args: { id: zid('crudNotes') },
	returns: z.literal('saved'),
	handler: (ctx, args) =>
		crud.commands
			.exec('crudNotes.update', { id: args.id, data: { title: 'must-roll-back' } }, ctx)
			.pipe(
				Effect.map(() => {
					// SAFETY: Deliberately violate the native output contract after successful command/audit writes.
					return 'invalid' as 'saved'
				}),
			),
})

// Internal raw state is an independent observer of the transaction's persisted writes.
export const state = internalQuery({
	args: { id: v.id('crudNotes') },
	returns: v.object({
		note: v.union(
			v.null(),
			v.object({
				title: v.string(),
				tenant: v.string(),
				owner: v.string(),
				secret: v.string(),
				archivedAt: v.optional(v.number()),
			}),
		),
		history: v.array(v.string()),
		audits: v.array(v.object({ operation: v.string(), actor: v.string() })),
	}),
	handler: async (ctx, { id }) => {
		const row = await ctx.db.get(id)
		const history = await ctx.db
			.query('crudHistory')
			.withIndex('by_note', (q) => q.eq('id', id))
			.take(20)
		const audits = await ctx.db
			.query('crudAudits')
			.withIndex('by_note', (q) => q.eq('id', id))
			.take(20)
		const note = row
			? {
					title: row.title,
					tenant: row.tenant,
					owner: row.owner,
					secret: row.secret,
					archivedAt: row.archivedAt,
				}
			: null
		if (note && note.archivedAt === undefined) delete note.archivedAt
		return {
			note,
			history: history.map((change) => change.operation),
			audits: audits.map((entry) => ({ operation: entry.operation, actor: entry.actor })),
		}
	},
})
