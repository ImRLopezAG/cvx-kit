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
