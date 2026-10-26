import { convexTest } from 'convex-test'
import {
	defineSchema,
	queryGeneric,
	mutationGeneric,
	actionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	internalActionGeneric,
	type GenericQueryCtx,
	type DataModelFromSchemaDefinition,
} from 'convex/server'
import { z } from 'zod'
import { zodTable, zodVariantTable } from '../../src/zod-table'
import { defineRelations } from '../../src/relations'
import { createQueryEngine, type FieldGroupPolicyContext } from '../../src/querying'
import { createAuthFunctions } from '../../src/auth'
import { cursor } from './scalar'
import type { ManagedBudgets } from '../../src/querying/security'

export function groupDeclarations() {
	const clients = zodTable(
		'clients',
		() => ({
			tenant: z.string(),
			name: z.string(),
			balance: z.bigint(),
			secret: z.string(),
			profile: z.object({ cents: z.number(), date: z.string().nullable() }),
		}),
		{ publicFields: ['name'] },
	)
	const accounts = zodTable(
		'accounts',
		(id) => ({
			tenant: z.string(),
			client: id('clients'),
			name: z.string(),
			balance: z.bigint(),
		}),
		{ publicFields: ['name'] },
	)
	const permissions = zodTable('permissions', () => ({
		tenant: z.string(),
		user: z.string(),
		clients: z.boolean(),
		accounts: z.boolean(),
	}))
	const variants = zodVariantTable(
		'variants',
		z.discriminatedUnion('kind', [
			z.strictObject({ kind: z.literal('finance'), tenant: z.string(), balance: z.bigint() }),
			z.strictObject({ kind: z.literal('ordinary'), tenant: z.string(), title: z.string() }),
		]),
		{
			discriminator: 'kind',
			variants: { finance: { publicFields: [] }, ordinary: { publicFields: ['title'] } },
		},
	)
	const clientsTable = clients.table.index('by_balance', ['balance'])
	const accountsTable = accounts.table.index('by_client', ['client'])
	const permissionTable = permissions.table.index('by_user', ['user'])
	const definitions = {
		clients: { ...clients, fieldGroups: { finance: ['balance', 'profile'] as const } },
		accounts: { ...accounts, fieldGroups: { finance: ['balance'] as const } },
		variants: { ...variants, fieldGroups: { finance: ['balance'] as const } },
		permissions,
	}
	const relations = defineRelations(definitions, (r) => ({
		clients: { accounts: r.many.accounts({ from: r.clients._id, to: r.accounts.client }) },
		accounts: { owner: r.one.clients({ from: r.accounts.client, to: r.clients._id }) },
	}))
	const schema = defineSchema({
		clients: clientsTable,
		accounts: accountsTable,
		permissions: permissionTable,
		variants: variants.table,
	})
	return { clients, accounts, variants, permissions, definitions, relations, schema }
}

export function fieldGroupFixture(budgets?: Partial<ManagedBudgets>) {
	const f = groupDeclarations()
	const { clients, relations, schema } = f
	type DM = DataModelFromSchemaDefinition<typeof schema>
	const calls = { clients: 0, accounts: 0, variants: 0, candidates: 0 }
	const builders = {
		query: queryGeneric,
		mutation: mutationGeneric,
		action: actionGeneric,
		internalQuery: internalQueryGeneric,
		internalMutation: internalMutationGeneric,
		internalAction: internalActionGeneric,
	}
	const auth = createAuthFunctions<DM, 'reader'>({
		...builders,
		getAuthUser: async (ctx: GenericQueryCtx<DM> | { auth: GenericQueryCtx<DM>['auth'] }) => {
			const identity = await ctx.auth.getUserIdentity()
			return identity ? { id: identity.subject } : null
		},
		mapRole: () => 'reader',
		adminRoles: [],
		security: {
			tenancy: { tables: ['clients', 'accounts', 'permissions', 'variants'] },
			rules: () => ({
				clients: {
					read: async () => {
						calls.candidates++
						return true
					},
				},
				accounts: {
					read: async () => {
						calls.candidates++
						return true
					},
				},
				variants: {
					read: async () => {
						calls.candidates++
						return true
					},
				},
			}),
		},
	})
	const policies = {
		clients: {
			finance: async ({ db, scope }: FieldGroupPolicyContext<typeof schema>) => {
				calls.clients++
				return (
					(
						await db
							.query('permissions')
							.withIndex('by_user', (q) => q.eq('user', scope.principal ?? ''))
							.first()
					)?.clients === true
				)
			},
		},
		accounts: {
			finance: async ({ db, scope }: FieldGroupPolicyContext<typeof schema>) => {
				calls.accounts++
				return (
					(
						await db
							.query('permissions')
							.withIndex('by_user', (q) => q.eq('user', scope.principal ?? ''))
							.first()
					)?.accounts === true
				)
			},
		},
		variants: {
			finance: async ({ db, scope }: FieldGroupPolicyContext<typeof schema>) => {
				calls.variants++
				return (
					(
						await db
							.query('permissions')
							.withIndex('by_user', (q) => q.eq('user', scope.principal ?? ''))
							.first()
					)?.clients === true
				)
			},
		},
	}
	const querying = createQueryEngine(
		{ schema, relations },
		{ cursor, budgets, fieldGroups: policies },
	)
	const args = relations.tables.clients.paginationOpts({
		name: true,
		balance: true,
		accounts: { balance: true },
	})
	const optionalGroups = { fieldGroups: { finance: 'if-permitted' } } as const
	const requiredGroups = { fieldGroups: { finance: 'required' } } as const
	const nestedGroups = {
		...optionalGroups,
		relations: { accounts: { ...optionalGroups, relations: { owner: optionalGroups } } },
	} as const
	const page = auth.authQuery({
		args,
		returns: relations.tables.clients.pageDto({}, requiredGroups),
		handler: (ctx, args) => querying(ctx).clients.include({ finance: 'required' }).paginate(args),
	})
	const optional = auth.authQuery({
		args,
		returns: relations.tables.clients.pageDto({}, optionalGroups),
		handler: (ctx, args) =>
			querying(ctx).clients.include({ finance: 'if-permitted' }).paginate(args),
	})
	const plain = auth.authQuery({
		args,
		returns: relations.tables.clients.pageDto({}),
		handler: (ctx, args) => querying(ctx).clients.paginate(args),
	})
	const sorted = auth.authQuery({
		args,
		returns: relations.tables.clients.pageDto({}, optionalGroups),
		handler: (ctx, args) =>
			querying(ctx)
				.clients.include({ finance: 'if-permitted' })
				.orderBy('by_balance')
				.paginate(args),
	})
	const trusted = auth.authQuery({
		args,
		returns: relations.tables.clients.pageDto({}),
		handler: (ctx, args) => querying(ctx).clients.where({ balance: 42n }).paginate(args),
	})
	const nested = auth.authQuery({
		args,
		returns: relations.tables.clients.pageDto({ accounts: { owner: true } }, nestedGroups),
		handler: (ctx, args) =>
			querying(ctx)
				.clients.with({ accounts: { owner: true } }, nestedGroups)
				.paginate(args),
	})
	const nestedRequiredGroups = { relations: { accounts: requiredGroups } } as const
	const nestedRequired = auth.authQuery({
		args,
		returns: relations.tables.clients.pageDto({ accounts: true }, nestedRequiredGroups),
		handler: (ctx, args) =>
			querying(ctx).clients.with({ accounts: true }, nestedRequiredGroups).paginate(args),
	})
	const next = auth.authQuery({
		args: relations.tables.accounts
			.paginationOpts({ balance: true })
			.extend({ parent: clients.schema.shape._id }),
		returns: relations.tables.accounts.pageDto({ owner: true }, nestedGroups.relations.accounts),
		handler: (ctx, { parent, ...args }) =>
			querying(ctx)
				.clients.relation(parent, 'accounts')
				.with({ owner: true }, nestedGroups.relations.accounts)
				.paginate(args),
	})
	const variant = auth.authQuery({
		args: relations.tables.variants.paginationOpts({ variants: { finance: { balance: true } } }),
		returns: relations.tables.variants.pageDto({}, optionalGroups),
		handler: (ctx, args) =>
			querying(ctx).variants.include({ finance: 'if-permitted' }).paginate(args),
	})
	return {
		...f,
		querying,
		policies,
		calls,
		t: convexTest(schema, {
			'./_generated/server.ts': async () => builders,
			'./functions.ts': async () => ({
				page,
				optional,
				plain,
				sorted,
				trusted,
				nested,
				nestedRequired,
				next,
				variant,
			}),
		}),
	}
}

export async function seedFieldGroups(
	f: ReturnType<typeof fieldGroupFixture>,
	allowed = true,
	targetAllowed = allowed,
) {
	return f.t.run(async ({ db }) => {
		const permission = await db.insert('permissions', {
			tenant: 'one',
			user: 'user',
			clients: allowed,
			accounts: targetAllowed,
		})
		const parent = await db.insert('clients', {
			tenant: 'one',
			name: 'visible',
			balance: 42n,
			secret: 'never-public',
			profile: { cents: 42, date: null },
		})
		await db.insert('clients', {
			tenant: 'one',
			name: 'second',
			balance: 99n,
			secret: 'never-public',
			profile: { cents: 99, date: null },
		})
		for (const balance of [11n, 22n, 33n])
			await db.insert('accounts', { tenant: 'one', client: parent, name: 'account', balance })
		await db.insert('variants', { tenant: 'one', kind: 'finance', balance: 76n })
		return { permission, parent }
	})
}
