import { describe, it, expect } from 'vite-plus/test'
import { z } from 'zod'
import { getRelationMetadata, defineRelations } from '../src/relations'
import { paginated } from '../src/zod-table'
import { queryFailureContract } from '../src/querying'
import { SearchError, planSearch } from '../src/querying/search'
import { createPlanner } from '../src/querying/planner'
import { searchDeclarations } from './fixture-querying/search'

describe('U11.2 search contract', () => {
	it('captures active and staged native search metadata immutably', () => {
		const f = searchDeclarations()
		const meta = getRelationMetadata(f.relations).tables.docs
		expect(meta.searchIndexes).toEqual([
			{
				name: 'search_secret',
				searchField: 'secret',
				filterFields: [],
				staged: false,
			},
			{
				name: 'search_text',
				searchField: 'text',
				filterFields: ['status'],
				staged: false,
			},
			{ name: 'staged', searchField: 'text', filterFields: [], staged: true },
		])
		expect(Object.isFrozen(meta.searchIndexes[1].filterFields)).toBe(true)
		const identity = f.relations.identity
		f.table.searchIndex('late', { searchField: 'text' })
		expect(f.relations.identity).toBe(identity)
		expect(meta.searchIndexes).toHaveLength(3)
		expect(searchDeclarations().relations.identity).toBe(identity)
		const plain = defineRelations({ children: f.definitions.children }, () => ({}))
		expect(JSON.parse(plain.identity)[1][0]).toHaveLength(5)
	})
	it('plans only AND scalar equalities and keeps complete residual identity', () => {
		const f = searchDeclarations(),
			planner = createPlanner(f.schema, f.relations)
		const p = planSearch(
			planner,
			'docs',
			'search_text',
			'  hello  ',
			{ numItems: 2, cursor: null, filters: { status: 'active' } },
			[],
		)
		expect(p.text).toBe('hello')
		expect(p.equalities).toEqual([{ field: 'status', value: 'active' }])
		const or = planSearch(
			planner,
			'docs',
			'search_text',
			'hello',
			{
				numItems: 2,
				cursor: null,
				filters: { or: [{ status: 'active' }, { status: 'old' }] },
			},
			[],
		)
		expect(or.equalities).toEqual([])
		expect(
			planSearch(
				planner,
				'docs',
				'search_text',
				'hello',
				{ numItems: 2, cursor: null, filters: { status: 'active' } },
				[{ status: 'old' }],
			).plan.unsatisfiable,
		).toBe(true)
	})
	it('rejects invalid text/options/staged index and transports only owned errors', () => {
		const f = searchDeclarations(),
			planner = createPlanner(f.schema, f.relations)
		for (const [text, args, code] of [
			[' ', {}, 'SEARCH_TEXT_REQUIRED'],
			['x', { endCursor: 'private' }, 'SEARCH_END_CURSOR_UNSUPPORTED'],
			['x', { order: 'desc' }, 'SEARCH_ORDER_UNSUPPORTED'],
			['x', { maximumRowsRead: 1 }, 'SEARCH_OPTIONS_UNSUPPORTED'],
		] as const) {
			try {
				planSearch(planner, 'docs', 'search_text', text, { numItems: 1, cursor: null, ...args }, [])
				throw Error('accepted')
			} catch (error) {
				expect(queryFailureContract.project(error)).toMatchObject({
					_tag: 'DeclaredFailure',
					code,
					details: {},
				})
			}
		}
		expect(() =>
			planSearch(planner, 'docs', 'staged', 'x', { numItems: 1, cursor: null }, []),
		).toThrow('SEARCH_OPTIONS_UNSUPPORTED')
		expect(
			queryFailureContract.project(new SearchError('SEARCH_PROTOCOL_UNSUPPORTED')),
		).toMatchObject({ code: 'SEARCH_PROTOCOL_UNSUPPORTED' })
		expect(queryFailureContract.project({ code: 'SEARCH_TEXT_REQUIRED' })).toEqual({
			_tag: 'UnknownFailure',
			version: 1,
		})
	})
	it('retains the search page marker through generic return validation', () => {
		expect(
			paginated(z.object({ id: z.string() })).result.parse({
				page: [],
				isDone: false,
				continueCursor: 'x',
				paginationMode: 'native-search',
			}).paginationMode,
		).toBe('native-search')
	})
})

import { executeSearch } from '../src/querying/search'
import { createCursorCodec, type CursorBinding } from '../src/querying/cursors'
import { cursor } from './fixture-querying/scalar'
import type { ExecutionRequest } from '../src/querying/execution'
import type { GenericDocument } from 'convex/server'
const binding: CursorBinding = {
	table: 'docs',
	index: 'search_text',
	order: 'asc',
	clientFilters: {},
	serverFilters: { search: 'hello' },
	relationPath: [],
	principal: 'reader',
	policyVersion: '1',
	engineVersion: '1',
	registryVersion: '1',
}
// This adapter proves arithmetic/protocol only. Registered tests independently run real policies/DTOs.
function arithmeticRequest(rows: number, next = 'next', extra = {}) {
	const calls: number[] = []
	const request = {
		budgets: { searchCandidates: 3 },
		search: async (...args: Parameters<ExecutionRequest['search']>) => {
			const options = args[4]
			calls.push(options.numItems)
			return {
				page: Array.from({ length: rows }, (_, i) => ({
					_id: String(i),
					_creationTime: i,
					text: 'hello',
				})),
				isDone: false,
				continueCursor: next,
				...extra,
			}
		},
	}
	// SAFETY: arithmetic-only adapter exercises the search operation; real managed requests are tested separately.
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The arithmetic adapter omits managed operations it never invokes.
	return { request: request as unknown as ExecutionRequest, calls }
}
it('U11.3 full-window overshoot preserves every row and immutable branch seen on replay', async () => {
	const f = searchDeclarations(),
		planner = createPlanner(f.schema, f.relations),
		codec = createCursorCodec(cursor)
	const token = (seen: number, nativeCursor = 'before') =>
		codec.seal(JSON.stringify({ v: 1, mode: 'search', seen, nativeCursor }), binding)
	const run = async (seen: number, rows: number) => {
		const r = arithmeticRequest(rows)
		const p = planSearch(
			planner,
			'docs',
			'search_text',
			'hello',
			{ numItems: 3, cursor: token(seen), scanLimit: 9 },
			[],
		)
		const page = await executeSearch(
			r.request,
			'docs',
			p,
			codec,
			binding,
			100,
			async (row: GenericDocument) => row,
		)
		return {
			...page,
			seen: JSON.parse(codec.open(page.continueCursor, binding)).seen,
			calls: r.calls,
		}
	}
	expect(await run(6, 5)).toMatchObject({
		seen: 11,
		isDone: true,
		completeness: 'result-cap',
		calls: [3],
		page: expect.any(Array),
	})
	expect((await run(6, 5)).page).toHaveLength(5)
	expect((await run(3, 3)).seen).toBe(6)
	expect((await run(4, 3)).seen).toBe(7)
	expect((await run(3, 3)).seen).toBe(6)
})
it('U11.3 rejects malformed/overflow seen, unchanged native boundaries, splits and incomplete native pages', async () => {
	const f = searchDeclarations(),
		planner = createPlanner(f.schema, f.relations),
		codec = createCursorCodec(cursor)
	const token = (data: { seen: number }) =>
		codec.seal(JSON.stringify({ v: 1, mode: 'search', nativeCursor: 'before', ...data }), binding)
	for (const seen of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		const r = arithmeticRequest(1),
			p = planSearch(
				planner,
				'docs',
				'search_text',
				'hello',
				{ numItems: 3, cursor: token({ seen }) },
				[],
			)
		await expect(
			executeSearch(r.request, 'docs', p, codec, binding, 100, async (row) => row),
		).rejects.toThrow('Invalid cursor')
		expect(r.calls).toEqual([])
	}
	for (const [seen, next, extra] of [
		[Number.MAX_SAFE_INTEGER, 'next', {}],
		[3, 'before', {}],
		[0, 'next', { pageStatus: 'SplitRequired' }],
		[0, 'next', { completeness: 'native-limit' }],
	] as const) {
		const r = arithmeticRequest(2, next, extra),
			p = planSearch(
				planner,
				'docs',
				'search_text',
				'hello',
				{ numItems: 3, cursor: token({ seen }) },
				[],
			)
		await expect(
			executeSearch(r.request, 'docs', p, codec, binding, 100, async (row) => row),
		).rejects.toThrow('SEARCH_PROTOCOL_UNSUPPORTED')
	}
})
