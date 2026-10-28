import {
	actionGeneric,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	defineSchema,
	makeFunctionReference,
	type GenericTableInfo,
	type QueryInitializer,
	type UserIdentity,
} from 'convex/server'
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vite-plus/test'

import {
	createAuthFunctions,
	createInclude,
	defaultRoleMap,
	type AuthFunctionsConfig,
} from '../src/auth'
import { KitError } from '../src/errors'

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

describe('resolved auth identity', () => {
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
	] as const)('preserves legacy call order and errors: %s', async (scenario) => {
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
			const authOptions: AuthFunctionsConfig<
				import('convex/server').DataModelFromSchemaDefinition<typeof emptySchema>,
				NonNullable<ReturnType<typeof defaultRoleMap>>
			> = {
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
			const auth = createAuthFunctions(authOptions)
			const result = auth.authenticatedUser(ctx)
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
		const config = {
			...authBuilders,
			getAuthUser: async (ctx) => {
				calls.push('user')
				await ctx.auth.getUserIdentity()
				calls.push('legacy-identity')
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
		} satisfies AuthFunctionsConfig<
			import('convex/server').GenericDataModel,
			'reader' | 'writer' | 'admin'
		>
		const auth = createAuthFunctions(config)
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
		expect(calls).toEqual(['user', 'legacy-identity', 'role', 'membership'])
	})
})
