import { defineSchema } from 'convex/server'
import { z } from 'zod'
import { zodTable } from '../../src/zod-table'
import { defineRelations } from '../../src/relations'

export function searchDeclarations() {
	const docs = zodTable(
		'docs',
		() => ({
			text: z.string().refine((value) => !value.includes('broken-dto')),
			status: z.string(),
			tenant: z.string(),
			secret: z.string(),
		}),
		{ publicFields: ['text', 'status'] },
	)
	const children = zodTable('children', (id) => ({ parent: id('docs'), name: z.string() }), {
		publicFields: ['name'],
	})
	const table = docs.table
		.searchIndex('search_text', {
			searchField: 'text',
			filterFields: ['status'],
		})
		.searchIndex('search_secret', { searchField: 'secret', filterFields: [] })
		.searchIndex('staged', { searchField: 'text', staged: true })
	const childTable = children.table.index('by_parent', ['parent'])
	const definitions = {
		docs: { ...docs, table, fieldGroups: { private: ['secret'] as const } },
		children: { ...children, table: childTable },
	}
	const relations = defineRelations(definitions, (r) => ({
		docs: {
			children: r.many.children({ from: r.docs._id, to: r.children.parent }),
			otherChildren: r.many.children({
				from: r.docs._id,
				to: r.children.parent,
			}),
		},
		children: {
			owner: r.one.docs({ from: r.children.parent, to: r.docs._id }),
		},
	}))
	const schema = defineSchema({ docs: table, children: childTable })
	return { docs, children, table, definitions, relations, schema }
}

import { convexTest } from 'convex-test'
import {
	queryGeneric,
	mutationGeneric,
	actionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	internalActionGeneric,
	type DataModelFromSchemaDefinition,
} from 'convex/server'
import { ConvexError } from 'convex/values'
import { Effect } from 'effect'
import { createAuthFunctions } from '../../src/auth'
import { createEffectAuthFunctions } from '../../src/effect'
import { createQueryEngine, queryFailureContract } from '../../src/querying'
import { cursor } from './scalar'
import type { ManagedBudgets, SecurityPolicyContext } from '../../src/querying/security'

export function searchFixture(budgets?: Partial<ManagedBudgets>) {
	const f = searchDeclarations()
	type DM = DataModelFromSchemaDefinition<typeof f.schema>
	const calls = { roots: 0, children: 0 }
	const control = { throwPolicy: false, readDependency: false }
	const config = {
		query: queryGeneric,
		mutation: mutationGeneric,
		action: actionGeneric,
		internalQuery: internalQueryGeneric,
		internalMutation: internalMutationGeneric,
		internalAction: internalActionGeneric,
		getAuthUser: async (ctx: {
			auth: { getUserIdentity: () => Promise<{ subject: string } | null> }
		}) => {
			const id = await ctx.auth.getUserIdentity()
			return id ? { id: id.subject } : null
		},
		mapRole: () => 'reader' as const,
		adminRoles: [] as const,
		security: {
			rules: () => ({
				docs: {
					read: async (ctx: SecurityPolicyContext<DM>, doc: DM['docs']['document']) => {
						calls.roots++
						if (control.throwPolicy) throw Error('private-policy-value')
						if (control.readDependency) await ctx.db.query('children').take(1)
						return doc.status !== 'denied'
					},
				},
				children: {
					read: async () => {
						calls.children++
						return true
					},
				},
			}),
		},
	}
	const auth = createAuthFunctions<DM, 'reader'>(config)
	const effect = createEffectAuthFunctions(config, {
		query: { errors: queryFailureContract },
		mutation: {},
		action: {},
		systemQuery: {},
		systemMutation: {},
		systemAction: {},
	})
	const engine = createQueryEngine(f, {
		cursor,
		budgets,
		fieldGroups: { docs: { private: () => false } },
	})
	const equivalent = createQueryEngine(searchDeclarations(), {
		cursor,
		budgets,
		fieldGroups: { docs: { private: () => false } },
	})
	const args = z.object({
		text: z.string(),
		options: z.any().optional(),
		index: z.string().optional(),
		fluent: z.string().optional(),
	})
	// SAFETY: the transport deliberately admits invalid index strings to test runtime admission.
	/* oxlint-disable anti-slop/no-reflect-apply, anti-slop/no-reflect-get -- Deliberately bypass fluent types to test raw JavaScript guards on registered endpoints. */
	const run = (ctx: Parameters<typeof engine>[0], a: z.output<typeof args>) => {
		let query = engine(ctx).docs
		if (a.fluent === 'when-before')
			query = Reflect.apply(Reflect.get(query, 'when'), undefined, [1, 'by_creation_time'])
		if (a.fluent?.startsWith('inactive-before-'))
			query = Reflect.apply(Reflect.get(query, 'when'), undefined, [
				a.fluent.endsWith('null') ? null : undefined,
				'by_creation_time',
			])
		if (a.fluent === 'order-before')
			query = Reflect.apply(Reflect.get(query, 'orderBy'), undefined, ['by_creation_time'])
		if (a.fluent === 'relation-search')
			query = Reflect.apply(Reflect.get(query, 'relation'), undefined, [
				'synthetic-parent',
				'children',
			])
		// SAFETY: invalid transport index strings deliberately exercise runtime admission.
		let searched = query.search((a.index ?? 'search_text') as 'search_text', a.text)
		if (a.fluent === 'when-after')
			Reflect.apply(Reflect.get(searched, 'when'), undefined, [1, 'by_creation_time'])
		if (a.fluent?.startsWith('inactive-after-'))
			searched = Reflect.apply(Reflect.get(searched, 'when'), undefined, [
				a.fluent.endsWith('null') ? null : undefined,
				'by_creation_time',
			])
		if (a.fluent === 'order-after')
			Reflect.apply(Reflect.get(searched, 'orderBy'), undefined, ['by_creation_time'])
		if (a.fluent === 'search-relation')
			Reflect.apply(Reflect.get(searched, 'relation'), undefined, ['synthetic-parent', 'children'])
		return searched.paginate({ numItems: 2, cursor: null, ...a.options })
	}
	/* oxlint-enable anti-slop/no-reflect-apply, anti-slop/no-reflect-get */
	const page = auth.authQuery({
		args,
		returns: f.relations.tables.docs.pageDto({}),
		handler: async (ctx, a) => {
			try {
				return await run(ctx, a)
			} catch (error) {
				throw new ConvexError(queryFailureContract.project(error))
			}
		},
	})
	const effectPage = effect.authQuery({
		args,
		returns: f.relations.tables.docs.pageDto({}),
		handler: (ctx, a) => Effect.tryPromise({ try: () => run(ctx, a), catch: (error) => error }),
	})
	const equivalentPage = auth.authQuery({
		args,
		returns: f.relations.tables.docs.pageDto({}),
		handler: (ctx, a) =>
			equivalent(ctx)
				.docs.search('search_text', a.text)
				.paginate({ numItems: 2, cursor: null, ...a.options }),
	})
	const nested = auth.authQuery({
		args,
		returns: f.relations.tables.docs.pageDto({ children: true }),
		handler: async (ctx, a) => {
			try {
				return await engine(ctx)
					.docs.search('search_text', a.text)
					.with({ children: true })
					.paginate({ numItems: 2, cursor: null, ...a.options })
			} catch (error) {
				throw new ConvexError(queryFailureContract.project(error))
			}
		},
	})
	const resume = auth.authQuery({
		args: z.object({
			parent: z.string(),
			cursor: z.string(),
			numItems: z.number(),
		}),
		returns: f.relations.tables.children.pageDto({}),
		// SAFETY: test seeds supply native docs IDs; relation admission still validates the parent.
		handler: (ctx, a) =>
			engine(ctx)
				.docs.relation(a.parent as import('convex/values').GenericId<'docs'>, 'children')
				.paginate({ cursor: a.cursor, numItems: a.numItems }),
	})
	const multiple = auth.authQuery({
		args,
		returns: f.relations.tables.docs.pageDto({
			children: true,
			otherChildren: true,
		}),
		handler: (ctx, a) =>
			engine(ctx)
				.docs.search('search_text', a.text)
				.with({ children: true, otherChildren: true })
				.paginate({ cursor: null, numItems: 2 }),
	})
	const deep = auth.authQuery({
		args,
		returns: f.relations.tables.docs.pageDto({
			children: { owner: { children: true } },
		}),
		handler: async (ctx, a) => {
			try {
				return await engine(ctx)
					.docs.search('search_text', a.text)
					.with({ children: { owner: { children: true } } })
					.paginate({ cursor: null, numItems: 3 })
			} catch (error) {
				throw new ConvexError(queryFailureContract.project(error))
			}
		},
	})
	const modules = {
		'./_generated/server.ts': async () => ({ query: queryGeneric }),
		'./functions.ts': async () => ({
			page,
			effectPage,
			equivalentPage,
			nested,
			resume,
			multiple,
			deep,
		}),
	}
	return { ...f, engine, calls, control, t: convexTest(f.schema, modules) }
}
