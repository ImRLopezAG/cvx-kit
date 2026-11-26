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
	type DefaultFunctionArgs,
	type GenericDatabaseReader,
	type GenericTableInfo,
	type GenericMutationCtx,
	type GenericQueryCtx,
	type QueryInitializer,
	type UserIdentity,
} from 'convex/server'
import { v } from 'convex/values'
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vite-plus/test'
import {
	createAuthFunctions,
	createAuthReaders,
	createInclude,
	defaultRoleMap,
	type AuthFunctionsConfig,
} from '../src/auth'
import { KitError } from '../src/errors'
import { k } from '../src/k'

describe('defaultRoleMap', () => {
	it('maps WorkOS member onto writer and passes known roles through', () => {
		expect(defaultRoleMap('member')).toBe('writer')
		expect(defaultRoleMap('  Admin ')).toBe('admin')
		expect(defaultRoleMap('reader')).toBe('reader')
	})

	it('rejects unknown roles instead of guessing', () => {
		expect(defaultRoleMap('owner')).toBeNull()
		expect(defaultRoleMap(undefined)).toBeNull()
	})
})

type Row = { _id: string }

function fakeQueryInitializer(rows: Row[]) {
	const calls: string[] = []
	function unsupported(): never {
		throw new Error('Unexpected query operation in include test')
	}
	const initializer: QueryInitializer<GenericTableInfo> = {
		take: async (limit) => rows.slice(0, limit),
		collect: unsupported,
		first: unsupported,
		unique: unsupported,
		paginate: unsupported,
		order: unsupported,
		filter: unsupported,
		withSearchIndex: unsupported,
		[Symbol.asyncIterator]: unsupported,
		withIndex: (indexName) => {
			calls.push(`withIndex:${indexName}`)
			return initializer
		},
		fullTableScan: () => {
			calls.push('fullTableScan')
			return initializer
		},
	}
	return { initializer, calls }
}

describe('createInclude', () => {
	const rows = Array.from({ length: 5 }, (_, index) => ({
		_id: `row_${index}`,
	}))

	it('selects the first matching index and bounds the read', async () => {
		const { initializer, calls } = fakeQueryInitializer(rows)
		const include = createInclude()
		const data = await include(initializer).matching('by_owner').matching('by_state').execute(3)
		expect(calls).toEqual(['withIndex:by_owner'])
		expect(data).toHaveLength(3)
	})

	it('falls back to a full scan only when nothing matched', async () => {
		const { initializer, calls } = fakeQueryInitializer(rows)
		const include = createInclude()
		await include(initializer)
			.when(null, (query) => query)
			.execute(2)
		expect(calls).toEqual(['fullTableScan'])
	})

	it('rejects unbounded or out-of-range limits', async () => {
		const { initializer } = fakeQueryInitializer(rows)
		const include = createInclude({ maxRows: 10 })
		await expect(include(initializer).execute(0)).rejects.toThrow(KitError)
		await expect(include(initializer).execute(11)).rejects.toThrow(/bounded query limit/)
		await expect(include(initializer).execute(2.5)).rejects.toThrow(KitError)
	})
})

const authBuilders = {
	query: queryGeneric,
	mutation: mutationGeneric,
	action: actionGeneric,
	internalQuery: internalQueryGeneric,
	internalMutation: internalMutationGeneric,
	internalAction: internalActionGeneric,
}
const resolvedIdentity: UserIdentity = {
	subject: 'subject',
	issuer: 'issuer',
	tokenIdentifier: 'issuer|subject',
	org_id: 'org',
	role: 'writer',
}
const emptySchema = defineSchema({})
type EmptyModel = DataModelFromSchemaDefinition<typeof emptySchema>
type Role = NonNullable<ReturnType<typeof defaultRoleMap>>

describe('createAuthFunctions: resolved auth identity', () => {
	it('passes the exact identity and unchanged context to an identity-aware principal lookup', async () => {
		const t = convexTest(emptySchema, { './_generated/server.ts': async () => ({}) })
		await t.run(async (nativeCtx) => {
			const calls: string[] = []
			const ctx = {
				...nativeCtx,
				auth: {
					getUserIdentity: async () => {
						calls.push('identity')
						return resolvedIdentity
					},
				},
			}
			const originalAuth = ctx.auth
			const auth = createAuthFunctions({
				...authBuilders,
				getAuthUser: async (receivedCtx, identity) => {
					calls.push('user')
					expect(receivedCtx).toBe(ctx)
					expect(identity).toBe(resolvedIdentity)
					return { id: identity.subject }
				},
				mapRole: defaultRoleMap,
				adminRoles: ['admin'],
			})
			const bundle = await auth.authenticatedUser(ctx)
			expect(bundle.identity).toBe(resolvedIdentity)
			expect(bundle.user.id).toBe('subject')
			expect(calls).toEqual(['identity', 'user'])
			expect(ctx.auth).toBe(originalAuth)
		})
	})

	it.each([
		'success',
		'anonymous',
		'missing-user',
		'unknown-role',
		'no-org',
		'resolver-error',
		'user-error',
	] as const)('preserves call order and errors: %s', async (scenario) => {
		const calls: string[] = []
		const t = convexTest(emptySchema, { './_generated/server.ts': async () => ({}) })
		await t.run(async (nativeCtx) => {
			const ctx = {
				...nativeCtx,
				auth: {
					getUserIdentity: async () => {
						calls.push('identity')
						return scenario === 'anonymous'
							? null
							: {
									...resolvedIdentity,
									org_id: scenario === 'no-org' ? undefined : 'org',
									role: scenario === 'unknown-role' ? 'unknown' : 'writer',
								}
					},
				},
			}
			const authOptions: AuthFunctionsConfig<EmptyModel, Role> = {
				...authBuilders,
				getAuthUser: async (receivedCtx) => {
					calls.push('user')
					expect(receivedCtx).toBe(ctx)
					if (scenario === 'user-error') throw new Error('lookup failed')
					return scenario === 'missing-user' ? null : { id: 'user' }
				},
				mapRole: (slug) => {
					calls.push('role')
					return defaultRoleMap(slug)
				},
				adminRoles: ['admin'],
			}
			if (scenario === 'resolver-error') {
				authOptions.resolveOrganization = async () => {
					calls.push('organization')
					throw new Error('resolver failed')
				}
			}
			const result = createAuthFunctions(authOptions).authenticatedUser(ctx)
			if (scenario === 'success')
				await expect(result).resolves.toMatchObject({ user: { id: 'user' }, tenant: 'org' })
			else
				await expect(result).rejects.toThrow(
					scenario === 'user-error'
						? /lookup failed/
						: scenario === 'unknown-role' || scenario === 'resolver-error'
							? /FORBIDDEN/
							: /UNAUTHENTICATED/,
				)
			const expected = scenario === 'anonymous' ? ['identity'] : ['identity', 'user']
			if (scenario === 'success' || scenario === 'unknown-role') expected.push('role')
			if (scenario === 'resolver-error') expected.push('organization')
			expect(calls).toEqual(expected)
		})
	})

	it('keeps action membership failure after principal and role resolution', async () => {
		const calls: string[] = []
		const auth = createAuthFunctions<EmptyModel, Role>({
			...authBuilders,
			getAuthUser: async (ctx) => {
				calls.push('user')
				await ctx.auth.getUserIdentity()
				calls.push('identity-in-lookup')
				return { id: 'user' }
			},
			mapRole: (slug) => {
				calls.push('role')
				return defaultRoleMap(slug)
			},
			adminRoles: ['admin'],
			verifyMembership: async () => {
				calls.push('membership')
				throw new Error('offline')
			},
		})
		const check = auth.authAction({
			args: {},
			handler: () => {
				calls.push('handler')
				return null
			},
		})
		const t = convexTest(emptySchema, {
			'./_generated/server.ts': async () => ({}),
			'./functions.ts': async () => ({ check }),
		}).withIdentity(resolvedIdentity)
		await expect(
			t.action(makeFunctionReference<'action', {}, null>('functions:check'), {}),
		).rejects.toThrow(/FORBIDDEN/)
		expect(calls).toEqual(['user', 'identity-in-lookup', 'role', 'membership'])
	})
})

describe('createAuthFunctions: args', () => {
	const checked: string[] = []
	const auth = createAuthFunctions<EmptyModel, Role>({
		...authBuilders,
		getAuthUser: async (_ctx, identity) => ({ id: identity.subject }),
		mapRole: defaultRoleMap,
		adminRoles: ['admin'],
	})
	const name = k
		.string()
		.trim()
		.refine((value) => {
			checked.push(value)
			return value.length > 0
		})
	const greet = auth.authQuery({
		args: { name, times: k.number().default(1) },
		handler: (ctx, args) => `${ctx.user.id}:${args.name}:${args.times}`,
	})
	const rename = auth.authMutation({
		args: k.object({ name }),
		handler: (ctx, args) => `${ctx.actor.role}:${args.name}`,
	})
	const t = convexTest(emptySchema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ greet, rename }),
	})
	const greetRef = makeFunctionReference<'query', { name: string; times?: number }, string>(
		'functions:greet',
	)
	const renameRef = makeFunctionReference<'mutation', { name: string }, string>('functions:rename')

	it('rejects an unauthenticated call before any args parse', async () => {
		checked.length = 0
		await expect(t.query(greetRef, { name: ' ada ' })).rejects.toThrow(/UNAUTHENTICATED/)
		await expect(t.mutation(renameRef, { name: ' ada ' })).rejects.toThrow(/UNAUTHENTICATED/)
		expect(checked).toEqual([])
	})

	it('passes parsed args to an authenticated handler and reports failures as VALIDATION', async () => {
		checked.length = 0
		const caller = t.withIdentity(resolvedIdentity)
		expect(await caller.query(greetRef, { name: ' ada ' })).toBe('subject:ada:1')
		expect(await caller.mutation(renameRef, { name: ' ada ' })).toBe('writer:ada')
		expect(checked).toEqual(['ada', 'ada'])
		await expect(caller.query(greetRef, { name: '  ' })).rejects.toMatchObject({
			data: { code: 'VALIDATION', issues: [{ path: ['name'], code: 'custom' }] },
		})
	})
})

const notesSchema = defineSchema({
	notes: defineTable({ tenant: v.string(), title: v.string() }),
})
type NotesModel = DataModelFromSchemaDefinition<typeof notesSchema>
type AuthContext = Parameters<AuthFunctionsConfig<NotesModel, Role>['getAuthUser']>[0]

describe('createAuthReaders', () => {
	const { mutation, internalMutation, ...readerBuilders } = authBuilders
	function base(verifyMembership?: AuthFunctionsConfig<NotesModel, Role>['verifyMembership']) {
		return {
			...readerBuilders,
			getAuthUser: async (_ctx: AuthContext, identity: UserIdentity) => ({
				id: identity.subject,
			}),
			mapRole: defaultRoleMap,
			adminRoles: ['admin'],
			verifyMembership,
			security: { tenancy: { tables: ['notes'] as const } },
		} satisfies Parameters<typeof createAuthReaders<NotesModel, Role>>[0]
	}
	function constructorsFor(config: ReturnType<typeof base>) {
		const readers = createAuthReaders<NotesModel, Role>(config)
		const full = createAuthFunctions<NotesModel, Role>({ ...config, mutation, internalMutation })
		return { readers, full }
	}
	function modules(auth: ReturnType<typeof constructorsFor>['readers']) {
		const list = (ctx: { db: GenericDatabaseReader<NotesModel> }) =>
			ctx.db
				.query('notes')
				.collect()
				.then((rows) => rows.map((row) => row.title))
		return {
			'./_generated/server.ts': async () => ({}),
			'./functions.ts': async () => ({
				who: auth.authQuery({
					args: {},
					handler: async (ctx) => ({ user: ctx.user.id, tenant: ctx.tenant, role: ctx.role }),
				}),
				list: auth.authQuery({ args: {}, handler: list }),
				adminList: auth.adminQuery({ args: {}, handler: list }),
				writerList: auth.roleQuery('writer')({ args: {}, handler: list }),
				act: auth.authAction({ args: {}, handler: async (ctx) => ctx.role }),
			}),
		}
	}
	const ref = <Type extends 'query' | 'action'>(_type: Type, name: string) =>
		makeFunctionReference<Type, {}, unknown>(`functions:${name}`)
	const identity = (org: string, role: string) => ({ ...resolvedIdentity, org_id: org, role })

	async function harness(auth: ReturnType<typeof constructorsFor>['readers']) {
		const t = convexTest(notesSchema, modules(auth))
		await t.run(async (ctx) => {
			await ctx.db.insert('notes', { tenant: 'org', title: 'mine' })
			await ctx.db.insert('notes', { tenant: 'other', title: 'theirs' })
		})
		return t
	}

	it('exposes every reader constructor and no mutation constructors', () => {
		const { readers, full } = constructorsFor(base())
		expect(Object.keys(readers).sort()).toEqual(
			[
				'include',
				'authenticatedUser',
				'authQuery',
				'roleQuery',
				'adminQuery',
				'serviceQuery',
				'systemQuery',
				'authAction',
				'roleAction',
				'adminAction',
				'systemAction',
			].sort(),
		)
		expect(Object.keys(full).sort()).toEqual(
			[
				...Object.keys(readers),
				'authMutation',
				'roleMutation',
				'adminMutation',
				'serviceMutation',
				'systemMutation',
			].sort(),
		)
	})

	it.each(['readers', 'full'] as const)(
		'%s: resolves identity and hides cross-tenant rows',
		async (kind) => {
			const t = await harness(constructorsFor(base())[kind])
			const caller = t.withIdentity(identity('org', 'writer'))
			expect(await caller.query(ref('query', 'who'), {})).toEqual({
				user: 'subject',
				tenant: 'org',
				role: 'writer',
			})
			expect(await caller.query(ref('query', 'list'), {})).toEqual(['mine'])
			await expect(t.query(ref('query', 'list'), {})).rejects.toThrow(/UNAUTHENTICATED/)
		},
	)

	it.each(['readers', 'full'] as const)('%s: gates roles and adminQuery', async (kind) => {
		const t = await harness(constructorsFor(base())[kind])
		const writer = t.withIdentity(identity('org', 'writer'))
		const admin = t.withIdentity(identity('org', 'admin'))
		await expect(writer.query(ref('query', 'adminList'), {})).rejects.toThrow(/FORBIDDEN/)
		expect(await admin.query(ref('query', 'adminList'), {})).toEqual(['mine'])
		expect(await writer.query(ref('query', 'writerList'), {})).toEqual(['mine'])
		await expect(admin.query(ref('query', 'writerList'), {})).rejects.toThrow(/FORBIDDEN/)
	})

	it.each(['readers', 'full'] as const)('%s: actions verify membership', async (kind) => {
		const rejecting = await harness(constructorsFor(base(async () => null))[kind])
		await expect(
			rejecting.withIdentity(identity('org', 'writer')).action(ref('action', 'act'), {}),
		).rejects.toThrow(/FORBIDDEN/)
		const verified = await harness(
			constructorsFor(base(async ({ organizationId }) => ({ organizationId, roleSlug: 'admin' })))[
				kind
			],
		)
		expect(
			await verified.withIdentity(identity('org', 'writer')).action(ref('action', 'act'), {}),
		).toBe('admin')
	})
})

describe('createAuthFunctions: service principals', () => {
	type Ctx = GenericQueryCtx<NotesModel> | GenericMutationCtx<NotesModel>
	const auth = createAuthFunctions<NotesModel, Role>({
		...authBuilders,
		getAuthUser: async () => {
			throw new Error('getAuthUser must not run for service principals')
		},
		mapRole: defaultRoleMap,
		adminRoles: ['admin'],
		security: { tenancy: { tables: ['notes'] } },
	})
	function bundleFor(tenant: string) {
		return {
			identity: resolvedIdentity,
			user: { id: `agent:${tenant}` },
			org: { organizationId: tenant, role: 'writer' as const },
			role: 'writer' as const,
			actor: { userId: `agent:${tenant}`, organizationId: tenant, role: 'writer' as const },
			tenant,
		}
	}
	/** The host derives the principal from the raw args of the invocation. */
	const principal = (_ctx: Ctx, args: DefaultFunctionArgs) => bundleFor(String(args.tenant))
	const scope = { tenant: k.string().trim() }
	const list = auth.serviceQuery(principal)({
		args: scope,
		handler: async (ctx, args) => ({
			actor: ctx.actor.userId,
			parsed: args.tenant,
			titles: (await ctx.db.query('notes').collect()).map((row) => row.title),
		}),
	})
	const write = auth.serviceMutation(principal)({
		args: { ...scope, title: k.string() },
		handler: async (ctx, args) => {
			await ctx.db.insert('notes', { tenant: ctx.tenant, title: args.title })
			return null
		},
	})
	// A host bug: the JSON round trip hides a bundle outside the contract from the type checker.
	const badBundle: ReturnType<typeof bundleFor> = JSON.parse(
		JSON.stringify({ ...bundleFor('org'), tenant: 7 }),
	)
	const malformed = auth.serviceQuery(() => badBundle)({
		args: {},
		handler: () => null,
	})
	const override = auth.serviceQuery((ctx: Ctx, args: DefaultFunctionArgs) => ({
		...principal(ctx, args),
		db: ctx.db,
	}))({ args: scope, handler: () => null })
	const t = convexTest(notesSchema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ list, write, malformed, override }),
	})

	it('derives the principal from raw args and applies the rules', async () => {
		await t.run(async (ctx) => {
			await ctx.db.insert('notes', { tenant: 'org', title: 'mine' })
			await ctx.db.insert('notes', { tenant: 'other', title: 'theirs' })
		})
		await t.mutation(makeFunctionReference<'mutation'>('functions:write'), {
			tenant: 'org',
			title: 'added',
		})
		// The principal sees the raw ' org ' tenant; the handler sees the trimmed arg.
		expect(
			await t.query(makeFunctionReference<'query'>('functions:list'), { tenant: ' org ' }),
		).toEqual({ actor: 'agent: org ', parsed: 'org', titles: [] })
		expect(
			await t.query(makeFunctionReference<'query'>('functions:list'), { tenant: 'org' }),
		).toEqual({ actor: 'agent:org', parsed: 'org', titles: ['mine', 'added'] })
	})

	it('rejects a principal outside the contract and one overriding native fields', async () => {
		await expect(
			t.query(makeFunctionReference<'query'>('functions:malformed'), {}),
		).rejects.toThrow('A service principal must be an AuthBundle with user.id and tenant')
		await expect(
			t.query(makeFunctionReference<'query'>('functions:override'), { tenant: 'org' }),
		).rejects.toThrow('cannot override native context fields: db')
	})
})
