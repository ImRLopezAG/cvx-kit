import type { DataModelFromSchemaDefinition } from 'convex/server'
import type { GenericId } from 'convex/values'
import { createQueryEngine, type SearchPaginationResult } from '../src/querying'
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
