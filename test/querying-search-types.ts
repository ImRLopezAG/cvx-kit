import {
	actionGeneric,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	type ApiFromModules,
	type DataModelFromSchemaDefinition,
	type FunctionReturnType,
} from 'convex/server'
import { Effect } from 'effect'
import { createAuthFunctions } from '../src/auth'
import { createEffectAuthFunctions } from '../src/effect'
import { k } from '../src/k'
import type { GenericId } from 'convex/values'
import {
	createQueryEngine,
	queryFailureContract,
	type SearchPaginationResult,
} from '../src/querying'
import type { ManagedQueryContext } from '../src/querying/security'
import { searchDeclarations } from './fixture-querying/search'
const f = searchDeclarations()
const engine = createQueryEngine(f, { budgets: { searchCandidates: 100 } })
declare const ctx: ManagedQueryContext<DataModelFromSchemaDefinition<typeof f.schema>>
const root = engine(ctx).docs
root
	.search('search_text', 'hello')
	.where({ status: 'active' })
	.with({ children: true })
	.paginate({ cursor: null, numItems: 2, scanLimit: 9 })
	.then((page) => {
		const mode: 'native-search' = page.paginationMode
		const id: GenericId<'docs'> = page.page[0]._id
		const child: GenericId<'children'> = page.page[0].children.page[0]._id
		const result: SearchPaginationResult<{ _id: GenericId<'docs'> }> = page
		void [mode, id, child, result]
		// @ts-expect-error private storage excluded
		void page.page[0].secret
	})
// @ts-expect-error unknown search index
root.search('foreign', 'x')
// @ts-expect-error staged search index
root.search('staged', 'x')
// @ts-expect-error ordinary native index
engine(ctx).children.search('by_parent', 'x')
// @ts-expect-error browse-only order
root.search('search_text', 'x').orderBy('by_creation_time')
// @ts-expect-error browse-only endCursor
root.search('search_text', 'x').paginate({ cursor: null, numItems: 1, endCursor: 'x' })
declare const parent: GenericId<'docs'>
root
	.relation(parent, 'children')
	.where({ name: 'x' })
	// @ts-expect-error direct relations cannot search
	.search('search_text', 'x')
// @ts-expect-error search cannot open direct relation
root.search('search_text', 'x').relation(parent, 'children')

// Registered search pages, plain and Effect, keep the required search marker in their results.
const config = {
	query: queryGeneric,
	mutation: mutationGeneric,
	action: actionGeneric,
	internalQuery: internalQueryGeneric,
	internalMutation: internalMutationGeneric,
	internalAction: internalActionGeneric,
	getAuthUser: async () => ({ id: 'reader' }),
	mapRole: () => 'reader' as const,
	adminRoles: [],
}
type SearchDM = DataModelFromSchemaDefinition<typeof f.schema>
const auth = createAuthFunctions<SearchDM, 'reader'>(config)
const effect = createEffectAuthFunctions(config, {
	query: { errors: queryFailureContract },
	mutation: {},
	action: {},
	systemQuery: {},
	systemMutation: {},
	systemAction: {},
})
const searchArgs = k.object({ text: k.string() })
function runSearch(ctx: Parameters<typeof engine>[0], { text }: k.infer<typeof searchArgs>) {
	return engine(ctx).docs.search('search_text', text).paginate({ numItems: 2, cursor: null })
}
const authPage = auth.authQuery({
	args: searchArgs,
	returns: f.relations.tables.docs.pageDto({}),
	handler: (ctx, a) => runSearch(ctx, a),
})
const effectPage = effect.authQuery({
	args: searchArgs,
	returns: f.relations.tables.docs.pageDto({}),
	handler: (ctx, a) => Effect.tryPromise({ try: () => runSearch(ctx, a), catch: (error) => error }),
})
type SearchApi = ApiFromModules<{
	search: { page: typeof authPage; effectPage: typeof effectPage }
}>
type RegisteredSearch =
	| FunctionReturnType<SearchApi['search']['page']>
	| FunctionReturnType<SearchApi['search']['effectPage']>
export const registeredMode = (page: RegisteredSearch): 'native-search' => page.paginationMode
