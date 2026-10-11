import { convexTest } from 'convex-test'
import {
	actionGeneric,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	type GenericQueryCtx,
} from 'convex/server'
import { createAuthFunctions } from '../../src/auth'
import { createQueryEngine } from '../../src/querying'
import { declarations, cursor, type DM } from './scalar'

export function authenticatedFixture() {
	const f = declarations()
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
			const id = await ctx.auth.getUserIdentity()
			return id ? { id: id.subject } : null
		},
		mapRole: () => 'owner' as const,
		adminRoles: ['owner'] as const,
	}
	const defaultAuth = createAuthFunctions<DM, 'owner'>(config)
	const composedAuth = createAuthFunctions<DM, 'owner'>({
		...config,
		security: {
			tenancy: { tables: ['tasks', 'permissions'] },
			rules: () => ({
				tasks: {
					read: async ({ db }, row) =>
						row.permission ? !!(await db.get('permissions', row.permission)) : false,
				},
				permissions: { read: async (_ctx, row) => row.allowed },
			}),
		},
	})
	const querying = createQueryEngine({ schema: f.schema, relations: f.relations, cursor })
	const args = f.tasks.paginationOpts({ status: true })
	const returns = f.relations.tables.tasks.pageDto({})
	const open = defaultAuth.authQuery({
		args,
		returns,
		handler: (ctx, args) => querying(ctx).tasks.where({ tenant: 'one' }).paginate(args),
	})
	const composed = composedAuth.authQuery({
		args,
		returns,
		handler: (ctx, args) => {
			const copied = { ...ctx, tenant: 'forged', actor: { ...ctx.actor, userId: 'forged' } }
			return querying(copied).tasks.where({ tenant: 'one' }).paginate(args)
		},
	})
	const mutation = composedAuth.authMutation({
		args: {},
		handler: (ctx) => {
			// SAFETY: this runtime regression deliberately passes a known writer through the query-only type boundary.
			return querying(ctx as never).tasks.paginate({ numItems: 1, cursor: null })
		},
	})
	const t = convexTest(f.schema, {
		'./_generated/server.ts': async () => builders,
		'./functions.ts': async () => ({ open, composed, mutation }),
	})
	return { ...f, t }
}
