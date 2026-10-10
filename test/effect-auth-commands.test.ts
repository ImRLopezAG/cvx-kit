import { Effect } from 'effect'
import { convexTest } from 'convex-test'
import {
	actionGeneric,
	defineSchema,
	defineTable,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	makeFunctionReference,
	mutationGeneric,
	queryGeneric,
	type DataModelFromSchemaDefinition,
	type GenericMutationCtx,
	type GenericActionCtx,
} from 'convex/server'
import { v } from 'convex/values'
import { expect, it } from 'vite-plus/test'
import { z } from 'zod'
import type { AuthFunctionsConfig, AuthBundle } from '../src/auth'
import { createEffectAuthFunctions, createEffectFoundation } from '../src/effect'
import { createTriggers } from '../src/triggers'
const schema = defineSchema({
	writes: defineTable({ actor: v.string(), tenant: v.string(), value: v.string() }),
	history: defineTable({ actor: v.string(), tenant: v.string() }),
	audits: defineTable({ actor: v.string(), tenant: v.string(), operation: v.string() }),
})
type Model = DataModelFromSchemaDefinition<typeof schema>
type Role = 'owner' | 'viewer'
type Host = GenericMutationCtx<Model> & AuthBundle<Role>
const input = z.object({ targetTenant: z.string().optional(), fail: z.boolean().optional() })
const saveRef = makeFunctionReference<'mutation', z.input<typeof input>, null>('functions:save')
const actionRef = makeFunctionReference<'action', z.input<typeof input>, null>(
	'functions:actionSave',
)
const owner = { subject: 'alice', org_id: 'org-a', role: 'owner' }
function harness() {
	const triggers = createTriggers<Model>()
	triggers.register('writes', async (ctx, change) => {
		if (change.operation === 'insert')
			await ctx.innerDb.insert('history', {
				actor: change.newDoc.actor,
				tenant: change.newDoc.tenant,
			})
	})
	const foundation = createEffectFoundation({
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
		},
		writeAudit: (ctx: Host, entry) =>
			Effect.promise(() =>
				ctx.db.insert('audits', {
					actor: entry.actorId,
					tenant: ctx.tenant,
					operation: entry.operation,
				}),
			),
	})
	const inner = foundation.Command({
		context: (ctx: Host) => ctx,
		operations: ({ command }) => ({
			write: command({
				input,
				result: z.null(),
				classification: 'business',
				handler: (args, ctx) =>
					Effect.promise(async () => {
						await ctx.db.insert('writes', {
							actor: ctx.actor.userId,
							tenant: args.targetTenant ?? ctx.tenant,
							value: 'nested',
						})
						return null
					}),
				audit: (_args, ctx) => ({
					actorId: ctx.actor.userId,
					operation: 'notes.write',
					aggregate: { type: 'note', id: 'nested' },
				}),
			}),
		}),
	})
	const inFlight: number[][] = []
	const commands = foundation.Command({
		context: (ctx: Host) => ({ host: ctx, commands: inner.withContext(ctx) }),
		operations: ({ command }) => ({
			save: command({
				input,
				result: z.null(),
				classification: 'business',
				handler: (args, ctx) =>
					Effect.gen(function* () {
						yield* ctx.commands.exec('write', args)
						if (args.fail) {
							const counts = yield* Effect.promise(async () =>
								Promise.all(
									(['writes', 'history', 'audits'] as const).map(
										async (table) => (await ctx.host.db.query(table).collect()).length,
									),
								),
							)
							inFlight.push(counts)
							return yield* Effect.fail(Error('AFTER_NESTED_AUDIT'))
						}
						return null
					}),
				audit: (_args, ctx) => ({
					actorId: ctx.host.actor.userId,
					operation: 'notes.save',
					aggregate: { type: 'note', id: 'nested' },
				}),
			}),
		}),
	})
	const config: AuthFunctionsConfig<Model, Role> = {
		query: queryGeneric,
		mutation: mutationGeneric,
		action: actionGeneric,
		internalQuery: internalQueryGeneric,
		internalMutation: internalMutationGeneric,
		internalAction: internalActionGeneric,
		getAuthUser: async (ctx) => {
			const identity = await ctx.auth.getUserIdentity()
			return identity ? { id: identity.subject } : null
		},
		mapRole: (slug) => (slug === 'owner' || slug === 'viewer' ? slug : null),
		adminRoles: ['owner'],
		triggers,
		verifyMembership: async ({ organizationId }) => ({ organizationId, roleSlug: 'owner' }),
		security: {
			tenancy: { tables: ['writes', 'history', 'audits'] },
			rules: (bundle) => ({ writes: { insert: async () => bundle.role === 'owner' } }),
		},
	}
	const actionFoundation = createEffectFoundation({
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
		},
		writeAudit: () => undefined,
	})
	const actionCommands = actionFoundation.Command({
		context: (ctx: GenericActionCtx<Model> & AuthBundle<Role>) => ctx,
		operations: ({ command }) => ({
			save: command({
				input,
				result: z.null(),
				classification: 'business',
				audit: () => null,
				handler: (args, ctx) => Effect.promise(() => ctx.runMutation(saveRef, args)),
			}),
		}),
	})
	const functions = createEffectAuthFunctions(config, {
		query: {},
		mutation: { context: (ctx) => ({ commands: commands.withContext(ctx) }) },
		action: { context: (ctx) => ({ commands: actionCommands.withContext(ctx) }) },
		systemQuery: {},
		systemMutation: {},
		systemAction: {},
	})
	const save = functions.authMutation({
		args: input.shape,
		returns: z.null(),
		handler: (ctx, args) => ctx.commands.exec('save', args),
	})
	const actionSave = functions.authAction({
		args: input.shape,
		returns: z.null(),
		handler: (ctx, args) => ctx.commands.exec('save', args),
	})
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ save, actionSave }),
	})
	const stored = () =>
		t.run(async (ctx) => ({
			writes: await ctx.db.query('writes').collect(),
			history: await ctx.db.query('history').collect(),
			audits: await ctx.db.query('audits').collect(),
		}))
	return { t, stored, inFlight }
}
it('nested bound commands use the secured writer and audit trusted authority', async () => {
	const h = harness()
	await h.t.withIdentity(owner).mutation(saveRef, {})
	const state = await h.stored()
	expect(state.writes).toHaveLength(1)
	expect(state.history).toHaveLength(1)
	expect(state.audits.map((row) => row.operation)).toEqual(['notes.write', 'notes.save'])
	for (const row of [...state.writes, ...state.history, ...state.audits])
		expect(row).toMatchObject({ actor: 'alice', tenant: 'org-a' })
})
it('denies foreign tenant and viewer command writes through the factory', async () => {
	const h = harness()
	await expect(
		h.t.withIdentity(owner).mutation(saveRef, { targetTenant: 'org-b' }),
	).rejects.toThrow(/insert/i)
	await expect(
		h.t.withIdentity({ ...owner, role: 'viewer' }).mutation(saveRef, {}),
	).rejects.toThrow(/insert/i)
	expect(await h.stored()).toEqual({ writes: [], history: [], audits: [] })
})
it('rolls back nested writes, triggers and completed inner audit at the registered mutation boundary', async () => {
	const h = harness()
	await expect(h.t.withIdentity(owner).mutation(saveRef, { fail: true })).rejects.toThrow(
		'AFTER_NESTED_AUDIT',
	)
	expect(h.inFlight).toEqual([[1, 1, 1]])
	expect(await h.stored()).toEqual({ writes: [], history: [], audits: [] })
})
it('action commands delegate to the registered mutation and keep its rollback boundary', async () => {
	const h = harness()
	await expect(h.t.withIdentity(owner).action(actionRef, { fail: true })).rejects.toThrow(
		'AFTER_NESTED_AUDIT',
	)
	expect(h.inFlight).toEqual([[1, 1, 1]])
	expect(await h.stored()).toEqual({ writes: [], history: [], audits: [] })
	await h.t.withIdentity(owner).action(actionRef, {})
	expect((await h.stored()).audits).toHaveLength(2)
})
