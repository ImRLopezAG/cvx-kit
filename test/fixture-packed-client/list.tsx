import { usePaginatedList } from '../../src/react'
import type { FunctionReference, PaginationOptions } from 'convex/server'
import { defineErrorContract } from '../../src/errors'
type Row = { _id: string; title: string; ordinal: number }
type Query = FunctionReference<
	'query',
	'public',
	{ filters: { title: string }; paginationOpts: PaginationOptions },
	{
		page: Row[]
		continueCursor: string
		isDone: boolean
		completeness: 'complete' | 'row-budget'
		splitCursor?: string | null
		pageStatus?: 'SplitRecommended' | 'SplitRequired' | null
	}
>
const errors = defineErrorContract({ FORBIDDEN: { message: 'Forbidden', details: {} } })
export function List({ query }: { query: Query }) {
	const list = usePaginatedList(
		query,
		{ filters: { title: 'hello' } },
		{ pageSize: 20, resetIdentity: { subject: 'user', scope: 1 } },
	)
	const rows: Row[] = list.rows
	const reason: 'complete' | 'row-budget' | undefined = list.completeness
	const key: string = list.resetKey
	const loading: boolean = list.isLoading || list.isFetchingNextPage || list.hasNextPage
	// @ts-expect-error Row DTO is precise.
	const wrong: number = list.rows[0].title
	// @ts-expect-error Required query arguments remain required.
	usePaginatedList(query, {}, { pageSize: 10 })
	usePaginatedList(
		query,
		{
			filters: { title: 'a' },
			// @ts-expect-error Transport is supplied by the controller.
			paginationOpts: { numItems: 1, cursor: null },
		},
		{ pageSize: 10 },
	)
	const custom = usePaginatedList(query, 'skip', { pageSize: 1, errors })
	if (custom.failure?._tag === 'DeclaredFailure') {
		const code: 'FORBIDDEN' = custom.failure.code
		void code
	}
	void [rows, reason, key, loading, wrong]
	list.fetchNextPage()
	return null
}
