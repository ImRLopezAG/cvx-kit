import { convexTest } from 'convex-test'
import {
	actionGeneric,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	defineSchema,
	defineTable,
	type DataModelFromSchemaDefinition,
	type GenericQueryCtx,
} from 'convex/server'
import { anyApi } from 'convex/server'
import { v } from 'convex/values'
import { z } from 'zod'
import { describe, expect, it } from 'vite-plus/test'
import { createAuthFunctions } from '../src/auth'
import { createQueryEngine, CursorError } from '../src/querying'
import { groupDeclarations } from './fixture-querying/field-groups'
import { cursor as codecKeys } from './fixture-querying/scalar'
import { createManagedSecurity } from '../src/querying/security'
import { fieldGroupFixture, seedFieldGroups } from './fixture-querying/field-groups'

it('projects a requested stored group through a registered auth endpoint', async () => {
	const f = fieldGroupFixture()
	await seedFieldGroups(f)
	const page = await f.t
		.withIdentity({ subject: 'user', org_id: 'one', role: 'reader' })
		.query(anyApi.functions.page, { cursor: null, numItems: 1 })
	expect(page.page[0].balance).toBe(42n)
	expect(page.page[0]).not.toHaveProperty('secret')
	expect(page.page[0].profile).toEqual({ cents: 42, date: null })
	expect(f.calls.clients).toBe(1)
})

const groupIdentity = { subject: 'user', org_id: 'one', role: 'reader' }
const groupArgs = { cursor: null, numItems: 1 }

it('omits denied optional own keys and exposes only a fixed required-denial error', async () => {
	const f = fieldGroupFixture()
	await seedFieldGroups(f, false)
	const asUser = f.t.withIdentity(groupIdentity)
	const result = await asUser.query(anyApi.functions.optional, groupArgs)
	expect(Object.keys(result.page[0]).sort()).toEqual(['_id', 'name'])
	expect(JSON.stringify(result)).not.toMatch(/balance|profile|never-public|cents/)
	try {
		await asUser.query(anyApi.functions.page, groupArgs)
		throw new Error('unexpected acceptance')
	} catch (error) {
		expect(error).toMatchObject({ message: 'FIELD_GROUP_DENIED' })
		expect(JSON.stringify(error)).not.toMatch(/never-public|balance|profile|42|99/)
	}
	expect(f.calls.clients).toBe(2)
})

it('checks every client predicate recursively before candidate reads, including contradictions and variants', async () => {
	const f = fieldGroupFixture()
	await seedFieldGroups(f, false)
	const asUser = f.t.withIdentity(groupIdentity)
	for (const filters of [
		{ balance: 42n },
		{ not: { balance: 42n } },
		{ or: [{ name: 'impossible' }, { balance: 42n }] },
		{ and: [{ name: 'a' }, { name: 'b' }, { not: { balance: 42n } }] },
		{ accounts: { none: { or: [{ balance: 11n }] } } },
	]) {
		await expect(
			asUser.query(anyApi.functions.optional, { ...groupArgs, filters }),
		).rejects.toThrow('FIELD_GROUP_DENIED')
		expect(f.calls.candidates).toBe(0)
	}
	await expect(
		asUser.query(anyApi.functions.variant, {
			...groupArgs,
			filters: { not: { variant: { tag: 'finance', filters: { balance: 76n } } } },
		}),
	).rejects.toThrow('FIELD_GROUP_DENIED')
	expect(f.calls.candidates).toBe(0)
	await expect(asUser.query(anyApi.functions.sorted, groupArgs)).rejects.toThrow(
		'FIELD_GROUP_DENIED',
	)
	expect(f.calls.candidates).toBe(0)
})

it('requires opt-in even for allowed readers and keeps server constraints trusted', async () => {
	const f = fieldGroupFixture()
	await seedFieldGroups(f)
	const asUser = f.t.withIdentity(groupIdentity)
	await expect(
		asUser.query(anyApi.functions.plain, { ...groupArgs, filters: { balance: 42n } }),
	).rejects.toThrow('FIELD_GROUP_DENIED')
	expect(f.calls.clients).toBe(0)
	expect(f.calls.candidates).toBe(0)
	const trusted = await asUser.query(anyApi.functions.trusted, groupArgs)
	expect(trusted.page).toHaveLength(1)
	expect(trusted.page[0]).not.toHaveProperty('balance')
	await expect(
		asUser.query(anyApi.functions.trusted, { ...groupArgs, filters: { balance: 42n } }),
	).rejects.toThrow('FIELD_GROUP_DENIED')
})

it('binds modes and current decisions in both root cursor slots before traversal', async () => {
	const f = fieldGroupFixture()
	const { permission } = await seedFieldGroups(f)
	const asUser = f.t.withIdentity(groupIdentity)
	const first = await asUser.query(anyApi.functions.optional, groupArgs)
	const resumed = await asUser.query(anyApi.functions.optional, {
		...groupArgs,
		cursor: first.continueCursor,
	})
	expect(resumed.page[0].balance).toBe(99n)
	expect(f.calls.clients).toBe(2)
	await expect(
		asUser.query(anyApi.functions.page, { ...groupArgs, cursor: first.continueCursor }),
	).rejects.toThrow('Invalid cursor')
	await f.t.run(({ db }) => db.patch('permissions', permission, { clients: false }))
	const before = f.calls.candidates
	for (const slots of [{ cursor: first.continueCursor }, { endCursor: first.continueCursor }]) {
		await expect(
			asUser.query(anyApi.functions.optional, { ...groupArgs, ...slots }),
		).rejects.toThrow('Invalid cursor')
		expect(f.calls.candidates).toBe(before)
	}
	expect(f.calls.clients).toBe(5)
})

it('uses the managed dependency budget for group policies and redacts policy failures', async () => {
	const f = fieldGroupFixture({ readOperations: 1 })
	await seedFieldGroups(f)
	await expect(
		f.t.withIdentity(groupIdentity).query(anyApi.functions.optional, groupArgs),
	).rejects.toThrow('MANAGED_READ_BUDGET')
	expect(f.calls.clients).toBe(1)
	expect(f.calls.candidates).toBe(0)
})

const schema = defineSchema({
	tasks: defineTable({ tenant: v.string(), name: v.string(), permission: v.id('permissions') }),
	permissions: defineTable({ tenant: v.string(), allowed: v.boolean() }),
	globals: defineTable({ name: v.string() }),
})
type DM = DataModelFromSchemaDefinition<typeof schema>
const builders = {
	query: queryGeneric,
	mutation: mutationGeneric,
	action: actionGeneric,
	internalQuery: internalQueryGeneric,
	internalMutation: internalMutationGeneric,
	internalAction: internalActionGeneric,
}
const config = {
	...builders,
	getAuthUser: async (ctx: GenericQueryCtx<DM> | { auth: GenericQueryCtx<DM>['auth'] }) => {
		const identity = await ctx.auth.getUserIdentity()
		return identity ? { id: identity.subject } : null
	},
	mapRole: () => 'owner' as const,
	adminRoles: ['owner'] as const,
}
const auth = createAuthFunctions<DM, 'owner'>({
	...config,
	security: {
		tenancy: { tables: ['tasks', 'permissions'] },
		rules: () => ({
			permissions: { read: async (_ctx, row) => row.allowed },
			tasks: {
				read: async ({ db }, row) => !!(await db.get('permissions', row.permission)),
				insert: async ({ db }, row) => !!(await db.get('permissions', row.permission)),
				modify: async ({ db }, row) => !!(await db.get('permissions', row.permission)),
			},
		}),
	},
})
const unrestricted = createAuthFunctions<DM, 'owner'>(config)
const managed = createManagedSecurity<DM>({
	tables: ['tasks', 'permissions', 'globals'],
	policyVersion: 'v1',
})

const read = auth.authQuery({
	args: {},
	handler: async (ctx) => {
		const copied = { ...ctx, tenant: 'forged', actor: { ...ctx.actor, userId: 'forged' } }
		const request = managed(copied)
		const rows = await request.db.query('tasks').take(20)
		return {
			names: rows.map((row) => row.name),
			scope: request.scope,
			counters: { ...request.counters },
			ordinary: (await ctx.db.query('tasks').collect()).map((row) => row.name),
		}
	},
})
const globalRead = auth.authQuery({
	args: {},
	handler: async (ctx) => (await managed(ctx).db.query('globals').take(2)).length,
})
const facadeRead = auth.authQuery({
	args: {},
	handler: async (ctx) => {
		const initial = ctx.db.query('tasks')
		const chained = ctx.db
			.query('tasks')
			.withIndex('by_creation_time')
			.filter((q) => q.eq(q.field('tenant'), ctx.tenant))
			.order('asc')
		const iterator = chained[Symbol.asyncIterator]()
		const first = await iterator.next()
		await iterator.return?.()
		return {
			exposesRaw: [initial, chained, iterator].map((surface) =>
				['q', 'p', 'iterator', 'db'].some((field) => Reflect.has(surface, field)),
			),
			ordinary: (await initial.collect()).map((row) => row.name),
			first: first.done ? null : first.value.name,
			page: (await ctx.db.query('tasks').paginate({ cursor: null, numItems: 10 })).page.map(
				(row) => row.name,
			),
		}
	},
})
const trustedRead = auth.systemQuery({
	args: {},
	handler: async (ctx) => {
		const request = managed(ctx)
		return {
			count: (await request.db.query('globals').take(2)).length,
			mode: request.scope.mode,
			ordinary: (await ctx.db.query('globals').collect()).length,
		}
	},
})
const openRead = unrestricted.authQuery({
	args: {},
	handler: async (ctx) => ({
		count: (await managed(ctx).db.query('globals').take(2)).length,
		mode: managed(ctx).scope.mode,
	}),
})
const create = auth.authMutation({
	args: { name: z.string(), permission: z.string() },
	handler: async (ctx, args) => {
		const permission = ctx.db.normalizeId('permissions', args.permission)!
		return ctx.db.insert('tasks', { name: args.name, tenant: ctx.tenant, permission })
	},
})
const modify = auth.authMutation({
	args: { id: z.string() },
	handler: async (ctx, args) => {
		const id = ctx.db.normalizeId('tasks', args.id)!
		await ctx.db.patch('tasks', id, { name: 'modified' })
		await ctx.db.replace('tasks', id, {
			name: 'replaced',
			tenant: ctx.tenant,
			permission: (await ctx.db.get('tasks', id))!.permission,
		})
		await ctx.db.delete('tasks', id)
	},
})
const changedDependency = auth.authMutation({
	args: { permission: z.string() },
	handler: async (ctx, args) => {
		const permission = ctx.db.normalizeId('permissions', args.permission)!
		await ctx.db.insert('tasks', { name: 'before', tenant: ctx.tenant, permission })
		await ctx.db.patch('permissions', permission, { allowed: false })
		try {
			await ctx.db.insert('tasks', { name: 'after', tenant: ctx.tenant, permission })
			return false
		} catch {
			return true
		}
	},
})
function rejection(ctx: GenericQueryCtx<DM>) {
	try {
		managed(ctx)
		return 'unexpected acceptance'
	} catch (error) {
		return error instanceof Error ? error.message : 'unexpected error'
	}
}
const mutationCapability = auth.authMutation({ args: {}, handler: (ctx) => rejection(ctx) })
const systemMutationCapability = auth.systemMutation({ args: {}, handler: (ctx) => rejection(ctx) })
function managedActionRejection(ctx: { auth: GenericQueryCtx<DM>['auth'] }) {
	// SAFETY: the raw action is deliberately supplied to verify the private identity lookup fails closed.
	const invalid = ctx as GenericQueryCtx<DM>
	return rejection(invalid)
}
const actionCapability = auth.authAction({
	args: {},
	handler: (ctx) => {
		// SAFETY: deliberately exercise runtime rejection of an action with no database.
		return managedActionRejection(ctx)
	},
})
const systemActionCapability = auth.systemAction({
	args: {},
	handler: (ctx) => {
		// SAFETY: deliberately exercise runtime rejection of an action with no database.
		return managedActionRejection(ctx)
	},
})

function harness() {
	return convexTest(schema, {
		'./_generated/server.ts': async () => builders,
		'./functions.ts': async () => ({
			read,
			create,
			modify,
			changedDependency,
			globalRead,
			facadeRead,
			trustedRead,
			openRead,
			mutationCapability,
			systemMutationCapability,
			actionCapability,
			systemActionCapability,
		}),
	})
}
const api = anyApi.functions
const identity = { subject: 'one-user', org_id: 'one', role: 'owner' }

describe('managed security through actual Convex auth constructors (in memory)', () => {
	it('hides raw helper fields on ordinary queries, fluent results and iterators', async () => {
		const t = harness()
		await t.run(async (ctx) => {
			for (const [tenant, allowed, name] of [
				['one', true, 'visible'],
				['one', false, 'denied'],
				['two', true, 'foreign'],
			] as const) {
				const permission = await ctx.db.insert('permissions', { tenant, allowed })
				await ctx.db.insert('tasks', { tenant, name, permission })
			}
		})
		expect(await t.withIdentity(identity).query(api.facadeRead, {})).toEqual({
			exposesRaw: [false, false, false],
			ordinary: ['visible'],
			first: 'visible',
			page: ['visible'],
		})
	})
	it('composes tenancy and policy dependencies before returning candidates', async () => {
		const t = harness()
		await t.run(async (ctx) => {
			for (const [tenant, allowed, name] of [
				['one', true, 'visible'],
				['one', false, 'denied'],
				['two', true, 'foreign'],
			] as const) {
				const permission = await ctx.db.insert('permissions', { tenant, allowed })
				await ctx.db.insert('tasks', { tenant, name, permission })
			}
		})
		const result = await t.withIdentity(identity).query(api.read, {})
		expect(result.names).toEqual(['visible'])
		expect(result.ordinary).toEqual(['visible'])
		expect(result.scope).toEqual({
			mode: 'authenticated',
			principal: 'one-user',
			organization: 'one',
			tenant: 'one',
			role: 'owner',
			policyVersion: 'v1',
		})
		// Three root rows + end probe + two same-tenant policy dependencies.
		expect(result.counters.readOperations).toBe(6)
		expect(result.counters.rawCandidates).toBe(5)
	})
	it('supplies the authorized reader to insert, patch, replace and delete policies', async () => {
		const t = harness()
		const permissions = await t.run(async (ctx) => ({
			allowed: await ctx.db.insert('permissions', { tenant: 'one', allowed: true }),
			denied: await ctx.db.insert('permissions', { tenant: 'one', allowed: false }),
			foreign: await ctx.db.insert('permissions', { tenant: 'two', allowed: true }),
		}))
		const asOne = t.withIdentity(identity)
		for (const permission of [permissions.denied, permissions.foreign])
			await expect(asOne.mutation(api.create, { name: 'denied', permission })).rejects.toThrow(
				/insert access not allowed/,
			)
		const id = await asOne.mutation(api.create, {
			name: 'allowed',
			permission: permissions.allowed,
		})
		await asOne.mutation(api.modify, { id })
		expect((await asOne.query(api.read, {})).names).toEqual([])
	})
	it('registers no-security authQuery and trusted systemQuery while preserving defaults', async () => {
		const t = harness()
		await t.run((ctx) => ctx.db.insert('globals', { name: 'global' }))
		expect(await t.withIdentity(identity).query(api.globalRead, {})).toBe(0)
		expect(await t.withIdentity(identity).query(api.openRead, {})).toEqual({
			count: 1,
			mode: 'authenticated',
		})
		expect(await t.query(api.trustedRead, {})).toEqual({ count: 1, ordinary: 1, mode: 'system' })
	})
	it('does not register mutation or action contexts', async () => {
		const t = harness()
		const asOne = t.withIdentity(identity)
		expect(await asOne.mutation(api.mutationCapability, {})).toBe('UNMANAGED_QUERY_CONTEXT')
		expect(await t.mutation(api.systemMutationCapability, {})).toBe('UNMANAGED_QUERY_CONTEXT')
		expect(await asOne.action(api.actionCapability, {})).toBe('UNMANAGED_QUERY_CONTEXT')
		expect(await t.action(api.systemActionCapability, {})).toBe('UNMANAGED_QUERY_CONTEXT')
	})
	it('rechecks permissions between engine requests and after mutation dependency changes', async () => {
		const t = harness()
		const permission = await t.run((ctx) =>
			ctx.db.insert('permissions', { tenant: 'one', allowed: true }),
		)
		const asOne = t.withIdentity(identity)
		await asOne.mutation(api.create, { name: 'initial', permission })
		expect((await asOne.query(api.read, {})).names).toEqual(['initial'])
		expect(await asOne.mutation(api.changedDependency, { permission })).toBe(true)
		expect((await asOne.query(api.read, {})).names).toEqual([])
	})
})

// U6: use the actual auth constructors, not private reader registration.
it('seals and opens a bigint payload through a registered authenticated query', async () => {
	const f = groupDeclarations()
	const engine = createQueryEngine(f, { cursor: codecKeys })
	const codecAuth = createAuthFunctions<DataModelFromSchemaDefinition<typeof f.schema>, 'owner'>({
		...builders,
		getAuthUser: async (ctx) => {
			const user = await ctx.auth.getUserIdentity()
			return user ? { id: user.subject } : null
		},
		mapRole: () => 'owner',
		adminRoles: [],
	})
	const endpoint = codecAuth.authQuery({
		args: { token: z.string().optional() },
		handler: (ctx, args) => {
			const codec = engine.cursorCodec(ctx, {
				domain: 'native-clients-v1',
				bind: { sort: 'asc' },
				schema: z.strictObject({ native: z.string().nullable(), seen: z.bigint() }),
			})
			return args.token ? codec.open(args.token) : codec.seal({ native: null, seen: 42n })
		},
	})
	const t = convexTest(f.schema, {
		'./_generated/server.ts': async () => builders,
		'./codec.ts': async () => ({ endpoint }),
	})
	const user = t.withIdentity(identity)
	const token = await user.query(anyApi.codec.endpoint, {})
	expect(await user.query(anyApi.codec.endpoint, { token })).toEqual({ native: null, seen: 42n })
	await expect(
		t.withIdentity({ ...identity, subject: 'other' }).query(anyApi.codec.endpoint, { token }),
	).rejects.toThrow('Invalid cursor')
	expect(new CursorError()).toMatchObject({ code: 'invalid-cursor', message: 'Invalid cursor' })
})

it('rejects native, mutation and action contexts before adapters, keys or schemas can be used', async () => {
	const f = groupDeclarations()
	let adapterCalls = 0
	let schemaCalls = 0
	// Lazy environment configuration must never be reached by rejected contexts.
	const engine = createQueryEngine(f)
	const adapting = createQueryEngine(f, {
		cursor: codecKeys,
		trustedAdapter: () => {
			adapterCalls++
			return null
		},
	})
	const codecAuth = createAuthFunctions<DataModelFromSchemaDefinition<typeof f.schema>, 'owner'>({
		...builders,
		getAuthUser: async (ctx) => {
			const user = await ctx.auth.getUserIdentity()
			return user ? { id: user.subject } : null
		},
		mapRole: () => 'owner',
		adminRoles: [],
	})
	function reject(ctx: { auth: GenericQueryCtx<DM>['auth'] }, adapter = false) {
		// SAFETY: intentionally supply invalid JS contexts to the public boundary.
		return (adapter ? adapting : engine)
			.cursorCodec(ctx as never, {
				domain: 'native',
				bind: null,
				schema: z.string().transform((value) => {
					schemaCalls++
					return value
				}),
			})
			.seal('native')
	}
	const native = queryGeneric({ args: {}, handler: (ctx) => reject(ctx) })
	const mutation = codecAuth.authMutation({ args: {}, handler: (ctx) => reject(ctx, true) })
	const action = codecAuth.authAction({ args: {}, handler: (ctx) => reject(ctx, true) })
	const systemMutation = codecAuth.systemMutation({ args: {}, handler: (ctx) => reject(ctx, true) })
	const systemAction = codecAuth.systemAction({ args: {}, handler: (ctx) => reject(ctx, true) })
	const t = convexTest(f.schema, {
		'./_generated/server.ts': async () => builders,
		'./codec.ts': async () => ({ native, mutation, action, systemMutation, systemAction }),
	})
	const user = t.withIdentity(identity)
	await expect(user.query(anyApi.codec.native, {})).rejects.toThrow('UNMANAGED_QUERY_CONTEXT')
	for (const name of ['mutation', 'systemMutation'])
		await expect(user.mutation(anyApi.codec[name], {})).rejects.toThrow('UNMANAGED_QUERY_CONTEXT')
	for (const name of ['action', 'systemAction'])
		await expect(user.action(anyApi.codec[name], {})).rejects.toThrow('UNMANAGED_QUERY_CONTEXT')
	expect(adapterCalls).toBe(0)
	expect(schemaCalls).toBe(0)
})

it('keeps public cursor integrity separate from current native consumer authorization', async () => {
	const f = groupDeclarations()
	const engine = createQueryEngine(f, { cursor: codecKeys })
	const codecAuth = createAuthFunctions<DataModelFromSchemaDefinition<typeof f.schema>, 'owner'>({
		...builders,
		getAuthUser: async (ctx) => {
			const user = await ctx.auth.getUserIdentity()
			return user ? { id: user.subject } : null
		},
		mapRole: () => 'owner',
		adminRoles: [],
	})
	const options = { domain: 'native', bind: null, schema: z.strictObject({ seen: z.bigint() }) }
	const issue = codecAuth.authQuery({
		args: {},
		handler: (ctx) => engine.cursorCodec(ctx, options).seal({ seen: 1n }),
	})
	const resume = codecAuth.authQuery({
		args: { cursor: z.string() },
		handler: async (ctx, args) => {
			const value = engine.cursorCodec(ctx, options).open(args.cursor)
			if (!(await ctx.db.query('permissions').first())?.clients) throw new Error('DENIED')
			return value
		},
	})
	const t = convexTest(f.schema, {
		'./_generated/server.ts': async () => builders,
		'./codec.ts': async () => ({ issue, resume }),
	})
	const permission = await t.run(({ db }) =>
		db.insert('permissions', { tenant: 'one', user: 'one-user', clients: true, accounts: true }),
	)
	const user = t.withIdentity(identity)
	const token = await user.query(anyApi.codec.issue, {})
	expect(await user.query(anyApi.codec.resume, { cursor: token })).toEqual({ seen: 1n })
	await t.run(({ db }) => db.patch('permissions', permission, { clients: false }))
	await expect(user.query(anyApi.codec.resume, { cursor: token })).rejects.toThrow('DENIED')
})

it('contains rejecting async schema transforms and refinements on both synchronous codec operations', async () => {
	const f = groupDeclarations()
	const engine = createQueryEngine(f, { cursor: codecKeys })
	const codecAuth = createAuthFunctions<DataModelFromSchemaDefinition<typeof f.schema>, 'owner'>({
		...builders,
		getAuthUser: async (ctx) => {
			const user = await ctx.auth.getUserIdentity()
			return user ? { id: user.subject } : null
		},
		mapRole: () => 'owner',
		adminRoles: [],
	})
	const endpoint = codecAuth.authQuery({
		args: {},
		handler: (ctx) => {
			type Tree = { native: string; children: Tree[] }
			const tree: Tree = { native: 'root', children: [{ native: 'leaf', children: [] }] }
			const invalidTree = { native: 'root', children: [{ native: 42, children: [] }] }
			for (const warmed of [false, true]) {
				const schema: z.ZodType<Tree> = z.lazy(() =>
					z.object({ native: z.string(), children: z.array(schema) }),
				)
				if (warmed) expect(schema.parse(tree)).toEqual(tree)
				const binding = { domain: 'recursive-schema', bind: warmed }
				const codec = engine.cursorCodec(ctx, { ...binding, schema })
				expect(codec.open(codec.seal(tree))).toEqual(tree)
				expect(() => codec.seal(invalidTree)).toThrow('Invalid cursor')
				const invalidToken = engine
					.cursorCodec(ctx, { ...binding, schema: z.any() })
					.seal(invalidTree)
				expect(() => codec.open(invalidToken)).toThrow('Invalid cursor')
			}
			const options = { domain: 'reject-async', bind: null }
			const payload = { native: 'position' }
			const token = engine.cursorCodec(ctx, { ...options, schema: z.any() }).seal(payload)
			for (const schema of [
				z.any().transform(async () => {
					throw new Error('private-async-transform')
				}),
				z.any().refine(async () => {
					throw new Error('private-async-refinement')
				}),
				z.any().transform(() => Promise.reject(new Error('private-promise-transform'))),
				z.any().refine(() => Promise.reject(new Error('private-promise-refinement'))),
				z.object({
					native: z.string().transform(() => Promise.reject(new Error('private-nested-promise'))),
				}),
				z.any().superRefine(() => Promise.reject(new Error('private-super-refinement'))),
				z.any().check(() => Promise.reject(new Error('private-check'))),
				z
					.any()
					.transform(() => Promise.reject<string>(new Error('private-caught-transform')))
					.catch('fallback'),
				z
					.any()
					.refine(() => Promise.reject(new Error('private-caught-refinement')))
					.catch('fallback'),
				z.object({
					native: z.string().refine(() => Promise.reject(new Error('private-nested-refinement'))),
				}),
				z.preprocess(() => Promise.reject(new Error('private-preprocess')), z.any()),
				z.object({ missing: z.any().default(() => Promise.reject(new Error('private-default'))) }),
				z.object({
					missing: z.any().prefault(() => Promise.reject(new Error('private-prefault'))),
				}),
				z
					.promise(z.any().transform(() => Promise.reject(new Error('private-promise-schema'))))
					.transform(() => 'unused'),
				z.lazy(() => z.any().transform(() => Promise.reject(new Error('private-lazy-transform')))),
				z.any().transform(() =>
					Promise.resolve().then(() => {
						throw new Error('private-deferred-transform')
					}),
				),
				z.object({
					native: z.string().transform(async () => {
						throw new Error('private-nested-transform')
					}),
				}),
			]) {
				const codec = engine.cursorCodec(ctx, { ...options, schema })
				for (const run of [() => codec.seal(payload), () => codec.open(token)]) {
					expect(run).toThrow(CursorError)
					expect(run).toThrow('Invalid cursor')
				}
			}
			return null
		},
	})
	const t = convexTest(f.schema, {
		'./_generated/server.ts': async () => builders,
		'./codec.ts': async () => ({ endpoint }),
	})
	const unhandled: unknown[] = []
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Capture runtime rejection payloads verbatim for the no-leak proof.
	const capture = (reason: unknown) => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', capture)
	try {
		await t.withIdentity(identity).query(anyApi.codec.endpoint, {})
		// Drain the event-loop turn so rejected callbacks cannot escape after the assertion.
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(unhandled).toEqual([])
	} finally {
		process.off('unhandledRejection', capture)
	}
})
