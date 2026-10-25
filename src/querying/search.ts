import { z } from 'zod'
import type { createPlanner, QueryInput, StoredConstraint } from './planner'
import type { FilterAst, FilterScalar } from './filters'
import { MAX_PAGE_SIZE } from './filters'

export type SearchErrorCode =
	| 'SEARCH_TEXT_REQUIRED'
	| 'SEARCH_END_CURSOR_UNSUPPORTED'
	| 'SEARCH_ORDER_UNSUPPORTED'
	| 'SEARCH_RELATION_UNSUPPORTED'
	| 'SEARCH_OPTIONS_UNSUPPORTED'
	| 'SEARCH_PROTOCOL_UNSUPPORTED'
export class SearchError extends Error {
	constructor(readonly code: SearchErrorCode) {
		super(code)
		this.name = 'SearchError'
	}
}
export type SearchPaginationResult<Row> = Omit<
	import('../zod-table').EnginePaginationResult<Row>,
	'splitCursor' | 'pageStatus'
> & { paginationMode: 'native-search'; splitCursor: null; pageStatus: null }
export interface SearchInput {
	numItems: number
	cursor: string | null
	id?: number
	scanLimit?: number
	filters?: QueryInput['filters']
}
const searchInput = z.strictObject({
	numItems: z.number().int().positive(),
	cursor: z.string().nullable(),
	id: z.number().optional(),
	scanLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
	filters: z.any().optional(),
	endCursor: z.null().optional(),
})
const optionEnvelope = z.looseObject({
	endCursor: z.any().optional(),
	order: z.any().optional(),
	maximumRowsRead: z.any().optional(),
	maximumBytesRead: z.any().optional(),
	onEmptyBudget: z.any().optional(),
})
const nativePage = z.object({
	page: z.array(z.any()),
	isDone: z.boolean(),
	continueCursor: z.string(),
	splitCursor: z.null().optional(),
	pageStatus: z.null().optional(),
	completeness: z.literal('complete').optional(),
})

/** Search compilation deliberately supplies no browse indexes or expansion directives. */
export function planSearch(
	planner: ReturnType<typeof createPlanner>,
	table: string,
	index: string,
	text: string,
	input: SearchInput,
	constraints: readonly StoredConstraint[],
) {
	if (!z.string().safeParse(text).success || !text.trim())
		throw new SearchError('SEARCH_TEXT_REQUIRED')
	const envelope = optionEnvelope.safeParse(input)
	if (!envelope.success) throw new SearchError('SEARCH_OPTIONS_UNSUPPORTED')
	const raw = envelope.data
	if (raw.endCursor != null) throw new SearchError('SEARCH_END_CURSOR_UNSUPPORTED')
	if (Object.hasOwn(raw, 'order')) throw new SearchError('SEARCH_ORDER_UNSUPPORTED')
	if (
		['maximumRowsRead', 'maximumBytesRead', 'onEmptyBudget'].some((key) => Object.hasOwn(raw, key))
	)
		throw new SearchError('SEARCH_OPTIONS_UNSUPPORTED')
	const parsed = searchInput.safeParse(input)
	if (!parsed.success) throw new SearchError('SEARCH_OPTIONS_UNSUPPORTED')
	const metadata = planner.metadata.tables[table]?.searchIndexes.find(
		(candidate) => candidate.name === index && !candidate.staged,
	)
	if (!metadata) throw new SearchError('SEARCH_OPTIONS_UNSUPPORTED')
	const { scanLimit, endCursor: _endCursor, ...args } = parsed.data
	// Relation planning with no ordering uses the existing grammar with no browse index selection.
	// The shared filter grammar enforces browse page limits; search owns a soft target.
	const planned = planner.plan(
		table,
		{ ...args, numItems: Math.min(args.numItems, MAX_PAGE_SIZE) },
		[],
		constraints,
		undefined,
		'relation',
	)
	const plan = { ...planned, args: { ...planned.args, numItems: args.numItems } }
	const values = new Map<string, FilterScalar>()
	function equalities(ast: FilterAst): void {
		if (ast.kind === 'and') for (const child of ast.children) equalities(child)
		else if (ast.kind === 'scalar' && ast.operator === 'eq' && !Array.isArray(ast.value))
			values.set(ast.field, ast.value)
	}
	equalities(plan.residual)
	return {
		plan,
		text: text.trim(),
		metadata,
		scanLimit,
		equalities: metadata.filterFields
			.filter((field) => values.has(field))
			.map((field) => ({ field, value: values.get(field)! })),
	}
}

import type { GenericDataModel, GenericDocument } from 'convex/server'
import type { Value } from 'convex/values'
import { CursorError, type CursorBinding, type createCursorCodec } from './cursors'
import type { ManagedReadRequest } from './security'
import { rethrowQueryError } from './execution'

const payload = z.strictObject({
	v: z.literal(1),
	mode: z.literal('search'),
	nativeCursor: z.string().nullable(),
	seen: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
type SearchPlan = ReturnType<typeof planSearch>
/** One complete native window. No result token is minted until all descendants finish. */
export async function executeSearch(
	request: ManagedReadRequest<GenericDataModel>,
	table: string,
	search: SearchPlan,
	codec: ReturnType<typeof createCursorCodec>,
	binding: CursorBinding,
	maxPageSize: number,
	complete: (document: GenericDocument) => Promise<Record<string, Value> | null>,
): Promise<SearchPaginationResult<Record<string, Value>>> {
	let start: z.output<typeof payload> = {
		v: 1,
		mode: 'search',
		nativeCursor: null,
		seen: 0,
	}
	if (search.plan.args.cursor !== null) {
		try {
			start = payload.parse(JSON.parse(codec.open(search.plan.args.cursor, binding)))
		} catch {
			throw new CursorError()
		}
	}
	const cap = search.scanLimit
	const terminal = cap !== undefined && start.seen >= cap
	const finish = (
		page: Record<string, Value>[],
		nativeCursor: string | null,
		seen: number,
		isDone: boolean,
	): SearchPaginationResult<Record<string, Value>> => ({
		page,
		isDone,
		continueCursor: codec.seal(
			JSON.stringify({ v: 1, mode: 'search', nativeCursor, seen }),
			binding,
		),
		completeness: cap !== undefined && seen >= cap ? 'result-cap' : 'complete',
		paginationMode: 'native-search',
		splitCursor: null,
		pageStatus: null,
	})
	if (terminal || search.plan.unsatisfiable) return finish([], start.nativeCursor, start.seen, true)
	try {
		const options = {
			cursor: start.nativeCursor,
			numItems: Math.min(
				search.plan.args.numItems,
				maxPageSize,
				request.budgets.searchCandidates,
				cap === undefined ? Infinity : cap - start.seen,
			),
			id: search.plan.args.id,
		}
		const result = await request.search(
			table,
			search.metadata,
			search.text,
			search.equalities,
			options,
		)
		if (!nativePage.safeParse(result).success) throw new SearchError('SEARCH_PROTOCOL_UNSUPPORTED')
		if (!result.isDone && result.continueCursor === start.nativeCursor)
			throw new SearchError('SEARCH_PROTOCOL_UNSUPPORTED')
		const seen = start.seen + result.page.length
		if (!Number.isSafeInteger(seen)) throw new SearchError('SEARCH_PROTOCOL_UNSUPPORTED')
		const page: Record<string, Value>[] = []
		for (const document of result.page) {
			const projected = await complete(document)
			if (projected !== null) page.push(projected)
		}
		return finish(
			page,
			result.continueCursor,
			seen,
			result.isDone || (cap !== undefined && seen >= cap),
		)
	} catch (error) {
		if (error instanceof SearchError) throw error
		rethrowQueryError(error)
	}
}
