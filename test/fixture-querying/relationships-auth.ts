import { convexTest } from 'convex-test'
import {
	queryGeneric,
	mutationGeneric,
	actionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	internalActionGeneric,
	type GenericQueryCtx,
	type DataModelFromSchemaDefinition,
} from 'convex/server'
import { createAuthFunctions } from '../../src/auth'
import { relationshipFixture } from './relationships'
import type { ManagedBudgets } from '../../src/querying/security'

export function relationshipAuthFixture(
	options: {
		beforeRead?: (table: 'tasks' | 'labels' | 'edges') => Promise<void>
		budgets?: Partial<ManagedBudgets>
	} = {},
) {
	const f = relationshipFixture(options.budgets)
	type DM = DataModelFromSchemaDefinition<typeof f.schema>
	const builders = {
		query: queryGeneric,
		mutation: mutationGeneric,
		action: actionGeneric,
		internalQuery: internalQueryGeneric,
		internalMutation: internalMutationGeneric,
		internalAction: internalActionGeneric,
	}
	const auth = createAuthFunctions<DM, 'owner'>({
		...builders,
		getAuthUser: async (ctx: GenericQueryCtx<DM> | { auth: GenericQueryCtx<DM>['auth'] }) => {
			const id = await ctx.auth.getUserIdentity()
			return id ? { id: id.subject } : null
		},
		mapRole: () => 'owner',
		adminRoles: ['owner'],
		security: {
			tenancy: { tables: ['tasks', 'labels'] },
			rules: () => ({
				tasks: {
					read: async (_, row) => {
						await options.beforeRead?.('tasks')
						return row.allowed
					},
				},
				labels: {
					read: async (_, row) => {
						await options.beforeRead?.('labels')
						return row.allowed
					},
				},
				edges: {
					read: async (_, row) => {
						await options.beforeRead?.('edges')
						return row.allowed
					},
				},
			}),
		},
	})
	const page = auth.authQuery({
		args: f.relations.tables.tasks.paginationOpts({ ordinal: true, labels: { ordinal: true } }),
		returns: f.relations.tables.tasks.pageDto({ labels: { owner: true } }),
		handler: (ctx, args) =>
			f
				.querying(ctx)
				.tasks.with({ labels: { owner: true } })
				.paginate(args),
	})
	const next = auth.authQuery({
		args: f.labels.paginationOpts({ ordinal: true }).extend({ parent: f.tasks.schema.shape._id }),
		returns: f.relations.tables.labels.pageDto({ owner: true }),
		handler: (ctx, { parent, ...args }) =>
			f.querying(ctx).tasks.relation(parent, 'labels').with({ owner: true }).paginate(args),
	})
	const nestedPage = auth.authQuery({
		args: f.tasks.paginationOpts({ ordinal: true }),
		returns: f.relations.tables.tasks.pageDto({ labels: { owner: { labels: true } } }),
		handler: (ctx, args) =>
			f
				.querying(ctx)
				.tasks.with({ labels: { owner: { labels: true } } })
				.paginate(args),
	})
	const nestedNext = auth.authQuery({
		args: f.labels.paginationOpts({}).extend({ parent: f.tasks.schema.shape._id }),
		returns: f.relations.tables.labels.pageDto({}),
		handler: (ctx, { parent, ...args }) =>
			f.querying(ctx).tasks.relation(parent, 'labels.owner.labels').paginate(args),
	})
	return {
		...f,
		t: convexTest(f.schema, {
			'./_generated/server.ts': async () => builders,
			'./functions.ts': async () => ({ page, next, nestedPage, nestedNext }),
		}),
	}
}
