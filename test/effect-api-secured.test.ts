import { Context, Effect } from 'effect'
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
} from 'convex/server'
import { v } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { createAuthFunctions } from '../src/auth'
import { effectZodApiBuilder } from '../src/effect'
import { createTriggers } from '../src/triggers'

const schema = defineSchema({
	writes: defineTable({ actor: v.string(), tenant: v.string(), value: v.string() }),
	history: defineTable({ actor: v.string(), tenant: v.string(), value: v.string() }),
})
type DataModel = DataModelFromSchemaDefinition<typeof schema>
type Role = 'owner' | 'viewer'

class SecuredRequest extends Context.Service<
	SecuredRequest,
	{ db: GenericMutationCtx<DataModel>['db']; actor: string; tenant: string }
>()('SecuredApiRequest') {}

type SaveArgs = {
	actor: string
	tenant: string
	role: string
	value: string
	targetTenant?: string
	failAfterWrite?: boolean
}
const saveRef = makeFunctionReference<'mutation', SaveArgs, null>('functions:save')
const ownerIdentity = { subject: 'trusted-owner', org_id: 'tenant-a', role: 'owner' }
const callerFields = { actor: 'forged-actor', tenant: 'forged-tenant', role: 'owner' }

function harness() {
	const triggers = createTriggers<DataModel>()
	triggers.register('writes', async (ctx, change) => {
		if (change.operation !== 'insert') return
		await ctx.innerDb.insert('history', {
			actor: change.newDoc.actor,
			tenant: change.newDoc.tenant,
			value: change.newDoc.value,
		})
	})
	const auth = createAuthFunctions<DataModel, Role>({
		triggers,
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
		security: {
			tenancy: { tables: ['writes', 'history'] },
			rules: (bundle) => ({
				writes: { insert: async () => bundle.role === 'owner' },
			}),
		},
	})
	const mutation = effectZodApiBuilder(auth.authMutation, {
		services: (ctx) =>
			Context.make(SecuredRequest, {
				db: ctx.db,
				actor: ctx.actor.userId,
				tenant: ctx.tenant,
			}),
	})
	const inFlight: { actor: string; tenant: string; value: string }[][] = []
	const save = mutation({
		args: {
			actor: z.string(),
			tenant: z.string(),
			role: z.string(),
			value: z.string(),
			targetTenant: z.string().optional(),
			failAfterWrite: z.boolean().optional(),
		},
		returns: z.null(),
		handler: (_ctx, args) =>
			Effect.gen(function* () {
				const request = yield* SecuredRequest
				yield* Effect.promise(() =>
					request.db.insert('writes', {
						actor: request.actor,
						tenant: args.targetTenant ?? request.tenant,
						value: args.value,
					}),
				)
				if (args.failAfterWrite) {
					// Observe both real rows inside the transaction before rejecting it.
					const writes = yield* Effect.promise(() => request.db.query('writes').collect())
					const history = yield* Effect.promise(() => request.db.query('history').collect())
					inFlight.push(
						...[writes, history].map((rows) =>
							rows.map(({ actor, tenant, value }) => ({ actor, tenant, value })),
						),
					)
					return yield* Effect.fail(new Error('POST_WRITE_FAILURE'))
				}
				return null
			}),
	})
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ save }),
	})
	const stored = () =>
		t.run(async (ctx) => ({
			writes: await ctx.db.query('writes').collect(),
			history: await ctx.db.query('history').collect(),
		}))
	return { t, stored, inFlight }
}

describe('Effect API services from the registered secured auth builder', () => {
	it('writes through the secured service and fires the trigger with trusted actor and tenant', async () => {
		const { t, stored } = harness()
		await expect(
			t.withIdentity(ownerIdentity).mutation(saveRef, { ...callerFields, value: 'permitted' }),
		).resolves.toBeNull()
		const state = await stored()
		const expected = { actor: 'trusted-owner', tenant: 'tenant-a', value: 'permitted' }
		expect(state.writes).toHaveLength(1)
		expect(state.writes[0]).toMatchObject(expected)
		expect(state.history).toHaveLength(1)
		expect(state.history[0]).toMatchObject(expected)
	})

	it('denies a service write targeting a foreign tenant and persists no business or trigger rows', async () => {
		const { t, stored } = harness()
		await expect(
			t.withIdentity(ownerIdentity).mutation(saveRef, {
				...callerFields,
				value: 'foreign',
				targetTenant: 'tenant-b',
			}),
		).rejects.toThrow(/insert/i)
		expect(await stored()).toEqual({ writes: [], history: [] })
	})

	it('denies a viewer service write even when caller fields claim the owner role', async () => {
		const { t, stored } = harness()
		await expect(
			t.withIdentity({ ...ownerIdentity, subject: 'trusted-viewer', role: 'viewer' }).mutation(
				saveRef,
				{ ...callerFields, value: 'forbidden' },
			),
		).rejects.toThrow(/insert/i)
		expect(await stored()).toEqual({ writes: [], history: [] })
	})

	it('rolls back both the completed business write and trigger row after an Effect failure', async () => {
		const { t, stored, inFlight } = harness()
		await expect(
			t.withIdentity(ownerIdentity).mutation(saveRef, {
				...callerFields,
				value: 'rolled-back',
				failAfterWrite: true,
			}),
		).rejects.toThrow('POST_WRITE_FAILURE')
		const expected = { actor: 'trusted-owner', tenant: 'tenant-a', value: 'rolled-back' }
		expect(inFlight).toEqual([[expected], [expected]])
		expect(await stored()).toEqual({ writes: [], history: [] })
	})
})
