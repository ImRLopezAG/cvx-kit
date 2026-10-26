import { describe, expect, it } from 'vite-plus/test'
import {
	initialPagination,
	reconcilePagination,
	paginationView,
	nextPagination,
	type ListPage,
} from '../src/react/pagination-state'
const page: ListPage = {
	page: ['edge', 'edge'],
	continueCursor: 'next',
	isDone: false,
	completeness: 'row-budget',
}
describe('pure pagination epochs', () => {
	it('pins the preceding interval before opening its successor', () => {
		const loaded = reconcilePagination(initialPagination<ListPage>('one', 1, false), {
			'1:0': { ...page, page: ['A', 'B'], continueCursor: 'B' },
		})
		const pending = nextPagination(loaded)
		expect(pending.intervals['1:0'].endCursor).toBe('B')
		expect(pending.intervals['1:1'].cursor).toBe('B')
		expect(loaded.intervals['1:0'].endCursor).toBeUndefined()
	})
	it('preserves the fixed parent end through a budget-truncated nested split', () => {
		let state = reconcilePagination(initialPagination<ListPage>('one', 1, false), {
			'1:0': { ...page, continueCursor: 'Z', splitCursor: 'M', pageStatus: 'SplitRecommended' },
		})
		state = reconcilePagination(state, {
			'1:1': { ...page, continueCursor: 'F', splitCursor: 'C', pageStatus: 'SplitRequired' },
			'1:2': { ...page, page: ['after-M'], continueCursor: 'Z' },
		})
		state = reconcilePagination(state, {})
		expect(state.intervals['1:3']).toMatchObject({ cursor: null, endCursor: 'C' })
		expect(state.intervals['1:4']).toMatchObject({ cursor: 'C', endCursor: 'M' })
		state = reconcilePagination(state, {
			'1:3': { ...page, page: ['through-C'], continueCursor: 'C' },
			'1:4': { ...page, page: ['through-F', 'through-M'], continueCursor: 'M' },
		})
		expect(paginationView(state).rows).toEqual(['through-C', 'through-F', 'through-M', 'after-M'])
	})
	it('ignores old epoch results and makes repeated next requests a no-op while pending', () => {
		const initial = initialPagination<ListPage>('one', 1, false)
		const loaded = reconcilePagination(initial, { '1:0': page })
		const pending = nextPagination(loaded)
		expect(nextPagination(pending)).toBe(pending)
		expect(paginationView(pending)).toMatchObject({
			rows: ['edge', 'edge'],
			completeness: 'row-budget',
			isFetchingNextPage: true,
		})
		const reset = initialPagination<ListPage>('two', 2, false)
		expect(reconcilePagination(reset, { '1:0': page })).toBe(reset)
		expect(paginationView(reset).rows).toEqual([])
	})
	it('does not let a stale child replace a reset interval', () => {
		const split = reconcilePagination(initialPagination<ListPage>('one', 1, false), {
			'1:0': { ...page, splitCursor: 'middle', pageStatus: 'SplitRecommended' },
		})
		const reset = initialPagination<ListPage>('two', 2, false)
		expect(Object.keys(split.intervals)).toHaveLength(3)
		expect(reconcilePagination(reset, { '1:1': page, '1:2': page })).toBe(reset)
	})
})

describe('native search pagination epochs', () => {
	const search = { ...page, paginationMode: 'native-search' as const }
	it('appends one immutable successor, preserving the parent subscription and child input token', () => {
		let state = reconcilePagination(initialPagination<ListPage>('search', 10, false), {
			'10:0': search,
		})
		const first = state.intervals['10:0']
		state = nextPagination(state)
		expect(state.intervals['10:0']).toBe(first)
		expect(state.intervals['10:0'].endCursor).toBeUndefined()
		expect(state.intervals['10:1'].cursor).toBe('next')
		expect(nextPagination(state)).toBe(state)
		state = reconcilePagination(state, {
			'10:0': {
				...search,
				page: ['grown', 'edge', 'edge'],
				continueCursor: 'new-seen',
				isDone: true,
				completeness: 'result-cap',
			},
			'10:1': { ...search, page: ['child'], continueCursor: 'tail' },
		})
		expect(state.intervals['10:1'].cursor).toBe('next')
		expect(paginationView(state)).toMatchObject({
			rows: ['grown', 'edge', 'edge', 'child'],
			hasNextPage: true,
		})
		state = reconcilePagination(state, {
			'10:1': { ...search, page: ['child'], isDone: true, completeness: 'result-cap' },
		})
		expect(paginationView(state).hasNextPage).toBe(false)
	})
	it('continues an empty search page manually once while pending without an automatic loop', () => {
		const loaded = reconcilePagination(initialPagination<ListPage>('search', 11, false), {
			'11:0': { ...search, page: [] },
		})
		expect(loaded.order).toHaveLength(1)
		expect(paginationView(loaded).hasNextPage).toBe(true)
		const pending = nextPagination(loaded)
		expect(pending.order).toHaveLength(2)
		expect(nextPagination(pending)).toBe(pending)
		expect(pending.intervals['11:0'].endCursor).toBeUndefined()
	})
	for (const invalid of [
		{ ...search, paginationMode: undefined },
		{ ...search, paginationMode: 'unknown' },
		{ ...search, pageStatus: 'SplitRequired' as const, splitCursor: 'middle' },
		{ ...search, completeness: 'searchSplitRequired' },
		{ ...search, splitCursor: 'middle' },
	])
		it(`fails closed for changed or invalid search protocol ${JSON.stringify(invalid)}`, () => {
			let state = reconcilePagination(initialPagination<ListPage>('search', 12, false), {
				'12:0': search,
			})
			state = nextPagination(state)
			state = reconcilePagination(state, {
				// SAFETY: inject malformed transport metadata to exercise runtime protocol rejection.
				'12:1': { ...invalid, continueCursor: 'tail' } as ListPage,
			})
			expect(state.error).toBeDefined()
			expect(paginationView(state).rows).toEqual([])
			expect(state.intervals).toEqual({})
		})
	it('rejects a browse epoch changing to search and resets capability with identity', () => {
		let state = reconcilePagination(initialPagination<ListPage>('browse', 13, false), {
			'13:0': page,
		})
		state = reconcilePagination(state, { '13:0': search })
		expect(state.error).toBeDefined()
		const reset = reconcilePagination(initialPagination<ListPage>('new-search', 14, false), {
			'14:0': search,
			'13:0': page,
		})
		expect(nextPagination(reset).intervals['14:0'].endCursor).toBeUndefined()
	})
})

it('retains the token-level nonprogress guard in native search mode', () => {
	let state = reconcilePagination(initialPagination<ListPage>('search', 20, false), {
		'20:0': { ...page, paginationMode: 'native-search' },
	})
	state = nextPagination(state)
	state = reconcilePagination(state, {
		'20:1': { ...page, paginationMode: 'native-search' },
	})
	expect(state.error?.message).toBe('Non-progressing pagination cursor')
	expect(paginationView(state).rows).toEqual([])
})
