import { Effect } from 'effect'
import { convexTest } from 'convex-test'
import {
	actionGeneric,
	anyApi,
	defineSchema,
	defineTable,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	type DataModelFromSchemaDefinition,
	type DefaultFunctionArgs,
	type GenericMutationCtx,
	type GenericQueryCtx,
	type UserIdentity,
} from 'convex/server'
import { v } from 'convex/values'
import { z } from 'zod'
import { describe, expect, it } from 'vite-plus/test'
import {
	createAuthFunctions,
	type AuthBundle,
	type AuthFunctionsConfig,
	type SecurityConfig,
} from '../src/auth'
import { createEffectAuthFunctions } from '../src/effect'
import { createQueryEngine } from '../src/querying'
import { createManagedSecurity } from '../src/querying/security'
import { createTriggers } from '../src/triggers'
import { groupDeclarations } from './fixture-querying/field-groups'
import { cursor } from './fixture-querying/scalar'

const schema = defineSchema({
	notes: defineTable({ tenant: v.string(), clientId: v.string(), body: v.string() }),
	audit: defineTable({ actor: v.string() }),
})
type DM = DataModelFromSchemaDefinition<typeof schema>
type Role = 'owner' | 'agent'
const builders = {
	query: queryGeneric,
	mutation: mutationGeneric,
	action: actionGeneric,
	internalQuery: internalQueryGeneric,
	internalMutation: internalMutationGeneric,
	internalAction: internalActionGeneric,
}
const identity: UserIdentity = {
	subject: 'service',
	issuer: 'host',
	tokenIdentifier: 'host|service',
}
const rules: NonNullable<SecurityConfig<DM, Role>['rules']> = (bundle) => ({
	notes: {
		// The scope comes from a custom field on the host-supplied bundle.
		read: async (_ctx, row) => row.clientId === bundle.clientId,
		insert: async (_ctx, row) => row.clientId === bundle.clientId,
		modify: async () => false,
	},
})
const triggers = createTriggers<DM>()
triggers.register('notes', async (ctx, change) => {
	if (change.operation === 'insert') await ctx.innerDb.insert('audit', { actor: 'trigger' })
})
const config: AuthFunctionsConfig<DM, Role> = {
	...builders,
	triggers,
	getAuthUser: async () => {
		throw new Error('getAuthUser must not run for service principals')
	},
	mapRole: () => 'owner',
	adminRoles: ['owner'],
	security: { tenancy: { tables: ['notes'] }, rules },
}
const auth = createAuthFunctions<DM, Role>(config)
const managed = createManagedSecurity<DM>({ tables: ['notes'], policyVersion: 'v1' })

function bundleFor(clientId: string, organizationId: string) {
	return {
		identity,
		user: { id: `agent:${clientId}` },
		org: { organizationId, role: 'agent' as const },
		role: 'agent' as const,
		actor: { userId: `agent:${clientId}`, organizationId, role: 'agent' as const },
		tenant: organizationId,
		clientId,
	}
}
/** The trusted host derives the principal from the raw internal args — never from a JWT. */
function principal(_ctx: GenericQueryCtx<DM> | GenericMutationCtx<DM>, args: DefaultFunctionArgs) {
	return bundleFor(String(args.clientId), String(args.organizationId))
}
const scope = { clientId: z.string(), organizationId: z.string() }
const agentQuery = auth.serviceQuery(principal)
const agentMutation = auth.serviceMutation(principal)

const list = agentQuery({
	args: scope,
	handler: async (ctx) => {
		const request = managed(ctx)
		return {
			clientId: ctx.clientId,
			actor: ctx.actor.userId,
			bodies: (await ctx.include(ctx.db.query('notes')).execute(10)).map((row) => row.body),
			managed: (await request.db.query('notes').take(10)).map((row) => row.body),
			scope: request.scope,
		}
	},
})
const forged = agentQuery({
	args: { ...scope, principal: z.any().optional() },
	handler: async (ctx) => ctx.clientId,
})
const write = agentMutation({
	args: { ...scope, body: z.string(), clientFor: z.string() },
	handler: async (ctx, args) => {
		await ctx.db.insert('notes', { tenant: ctx.tenant, clientId: args.clientFor, body: args.body })
		return null
	},
})
const edit = agentMutation({
	args: scope,
	handler: async (ctx) => {
		const row = await ctx.include(ctx.db.query('notes')).execute(1)
		await ctx.db.patch(row[0]!._id, { body: 'edited' })
		return null
	},
})
/** A host mistake: an extra named like a native handle must not replace the secured one. */
const rawDbPrincipal = (ctx: GenericQueryCtx<DM> | GenericMutationCtx<DM>, args: DefaultFunctionArgs) => ({
	...principal(ctx, args),
	db: ctx.db,
})
const overrideRead = auth.serviceQuery(rawDbPrincipal)({
	args: scope,
	handler: async (ctx) => (await ctx.db.query('notes').collect()).length,
})
const overrideWrite = auth.serviceMutation(rawDbPrincipal)({
	args: scope,
	handler: async (ctx) => {
		await ctx.db.insert('notes', { tenant: 'org', clientId: 'c2', body: 'raw' })
		return null
	},
})
const systemList = auth.systemQuery({
	args: {},
	handler: async (ctx) => ({
		hasActor: 'actor' in ctx,
		mode: managed(ctx).scope.mode,
		count: (await ctx.db.query('notes').collect()).length,
	}),
})
const effectAuth = createEffectAuthFunctions(config, {
	query: { context: (ctx: AuthBundle<Role>) => ({ who: () => ctx.actor.userId }) },
	mutation: {},
	action: {},
	systemQuery: {},
	systemMutation: {},
	systemAction: {},
})
const effectList = effectAuth.serviceQuery(principal)({
	args: scope,
	handler: (ctx) =>
		Effect.promise(async () => ({
			who: ctx.who(),
			clientId: ctx.clientId,
			bodies: (await ctx.include(ctx.db.query('notes')).execute(10)).map((row) => row.body),
		})),
})
const effectWrite = effectAuth.serviceMutation(principal)({
	args: { ...scope, clientFor: z.string() },
	handler: (ctx, args) =>
		Effect.promise(() =>
			ctx.db.insert('notes', { tenant: ctx.tenant, clientId: args.clientFor, body: 'fx' }),
		),
})

function harness() {
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => builders,
		'./functions.ts': async () => ({
			list,
			forged,
			write,
			edit,
			overrideRead,
			overrideWrite,
			systemList,
			effectList,
			effectWrite,
		}),
	})
	const seed = () =>
		t.run(async (ctx) => {
			await ctx.db.insert('notes', { tenant: 'org', clientId: 'c1', body: 'mine' })
			await ctx.db.insert('notes', { tenant: 'org', clientId: 'c2', body: 'other' })
			await ctx.db.insert('notes', { tenant: 'elsewhere', clientId: 'c1', body: 'foreign' })
		})
	return { t, seed }
}
const api = anyApi.functions
const asClientOne = { clientId: 'c1', organizationId: 'org' }

describe('service principal constructors', () => {
	it('applies rules reading a custom bundle field on include and managed reads', async () => {
		const { t, seed } = harness()
		await seed()
		const result = await t.query(api.list, asClientOne)
		expect(result).toMatchObject({ clientId: 'c1', actor: 'agent:c1', bodies: ['mine'] })
		expect(result.managed).toEqual(['mine'])
		expect(result.scope).toMatchObject({
			mode: 'trusted',
			principal: 'agent:c1',
			organization: 'org',
			tenant: 'org',
			role: 'agent',
		})
	})

	it('rejects principal extras that would replace native context handles', async () => {
		const { t, seed } = harness()
		await seed()
		await expect(t.query(api.overrideRead, asClientOne)).rejects.toThrow(
			/cannot override native context fields: db/,
		)
		await expect(t.mutation(api.overrideWrite, asClientOne)).rejects.toThrow(
			/cannot override native context fields: db/,
		)
		await t.run(async (ctx) => {
			expect((await ctx.db.query('notes').collect()).map((row) => row.body)).not.toContain('raw')
		})
	})

	it('derives the principal from the host factory only, ignoring caller-supplied principals', async () => {
		const { t } = harness()
		const forgedPrincipal = bundleFor('c2', 'org')
		await expect(t.query(api.forged, { ...asClientOne, principal: forgedPrincipal })).resolves.toBe(
			'c1',
		)
	})

	it('runs the query engine under a service ctx without UNMANAGED_QUERY_CONTEXT', async () => {
		const f = groupDeclarations()
		type FDM = DataModelFromSchemaDefinition<typeof f.schema>
		const fixtureAuth = createAuthFunctions<FDM, Role>({
			...builders,
			getAuthUser: async () => null,
			mapRole: () => 'owner',
			adminRoles: ['owner'],
			security: {
				tenancy: { tables: ['clients', 'accounts', 'permissions', 'variants'] },
				rules: (bundle) => ({
					clients: { read: async (_ctx, row) => row.name !== bundle.hidden },
				}),
			},
		})
		const querying = createQueryEngine({ schema: f.schema, relations: f.relations }, { cursor })
		const args = f.relations.tables.clients
			.paginationOpts({ name: true })
			.extend({ hidden: z.string() })
		const page = fixtureAuth.serviceQuery((_ctx, raw) => ({
			...bundleFor('c1', 'one'),
			hidden: String(raw.hidden),
		}))({
			args,
			returns: f.relations.tables.clients.pageDto({}),
			handler: (ctx, { hidden: _hidden, ...args }) => querying(ctx).clients.paginate(args),
		})
		const t = convexTest(f.schema, {
			'./_generated/server.ts': async () => builders,
			'./engine.ts': async () => ({ page }),
		})
		await t.run(async (ctx) => {
			for (const name of ['a', 'b'])
				await ctx.db.insert('clients', {
					tenant: 'one',
					name,
					balance: 1n,
					secret: 's',
					profile: { cents: 1, date: null },
				})
		})
		const result = await t.query(anyApi.engine.page, {
			cursor: null,
			numItems: 10,
			hidden: 'b',
		})
		expect(result.page.map((row: { name: string }) => row.name)).toEqual(['a'])
	})

	it('refuses writes by a modify rule, allows permitted inserts, and keeps triggers', async () => {
		const { t, seed } = harness()
		await seed()
		await expect(
			t.mutation(api.write, { ...asClientOne, body: 'new', clientFor: 'c1' }),
		).resolves.toBeNull()
		expect(await t.run((ctx) => ctx.db.query('audit').collect())).toHaveLength(1)
		await expect(
			t.mutation(api.write, { ...asClientOne, body: 'new', clientFor: 'c2' }),
		).rejects.toThrow()
		await expect(t.mutation(api.edit, asClientOne)).rejects.toThrow()
		expect(await t.query(api.systemList, {})).toMatchObject({ count: 4 })
	})

	it('leaves systemQuery unchanged', async () => {
		const { t, seed } = harness()
		await seed()
		expect(await t.query(api.systemList, {})).toEqual({
			hasActor: false,
			mode: 'system',
			count: 3,
		})
	})

	it('exposes service constructors through createEffectAuthFunctions', async () => {
		const { t, seed } = harness()
		await seed()
		expect(await t.query(api.effectList, asClientOne)).toEqual({
			who: 'agent:c1',
			clientId: 'c1',
			bodies: ['mine'],
		})
		await expect(t.mutation(api.effectWrite, { ...asClientOne, clientFor: 'c2' })).rejects.toThrow()
		await expect(
			t.mutation(api.effectWrite, { ...asClientOne, clientFor: 'c1' }),
		).resolves.toBeTypeOf('string')
	})
})
