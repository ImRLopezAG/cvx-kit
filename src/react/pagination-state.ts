/** Pure interval controller. Keys include the epoch so late subscription results cannot enter a reset. */
export type ListPage = {
	page: unknown[]
	continueCursor: string
	isDone: boolean
	completeness?: string
	splitCursor?: string | null
	pageStatus?: 'SplitRecommended' | 'SplitRequired' | null
}
type Interval<Page extends ListPage> = {
	cursor: string | null
	endCursor?: string
	value?: Page
	children?: [string, string]
}
export type PaginationState<Page extends ListPage> = {
	epoch: number
	identity: string
	restarted: boolean
	next: number
	order: string[]
	intervals: Record<string, Interval<Page>>
	error?: Error
}
export function initialPagination<Page extends ListPage>(
	identity: string,
	epoch: number,
	skip: boolean,
	restarted = false,
): PaginationState<Page> {
	const key = `${epoch}:0`
	return {
		identity,
		epoch,
		restarted,
		next: 1,
		order: skip ? [] : [key],
		intervals: skip ? {} : { [key]: { cursor: null } },
	}
}
export function failPagination<Page extends ListPage>(
	state: PaginationState<Page>,
	error: Error,
): PaginationState<Page> {
	return { ...state, order: [], intervals: {}, error }
}
export function reconcilePagination<Page extends ListPage>(
	state: PaginationState<Page>,
	results: Record<string, Page | Error | undefined>,
): PaginationState<Page> {
	if (state.error) return state
	let changed = false
	const intervals = { ...state.intervals }
	for (const key of Object.keys(intervals)) {
		const value = results[key]
		if (value instanceof Error) return failPagination(state, value)
		if (value !== undefined && value !== intervals[key].value) {
			intervals[key] = { ...intervals[key], value }
			changed = true
		}
	}
	let order = state.order,
		next = state.next
	for (const key of state.order) {
		const interval = intervals[key],
			value = interval.value
		if (!value) continue
		if (interval.children) {
			if (interval.children.every((child) => intervals[child].value !== undefined)) {
				order = order.flatMap((item) => (item === key ? interval.children! : [item]))
				delete intervals[key]
				changed = true
			}
		} else if (value.pageStatus === 'SplitRecommended' || value.pageStatus === 'SplitRequired') {
			const split = value.splitCursor
			if (
				!split ||
				split === interval.cursor ||
				split === value.continueCursor ||
				split === interval.endCursor ||
				value.continueCursor === interval.cursor
			)
				return failPagination(state, new Error('Non-progressing pagination split'))
			const children: [string, string] = [`${state.epoch}:${next++}`, `${state.epoch}:${next++}`]
			intervals[key] = { ...interval, children }
			intervals[children[0]] = { cursor: interval.cursor, endCursor: split }
			intervals[children[1]] = {
				cursor: split,
				endCursor: interval.endCursor ?? value.continueCursor,
			}
			changed = true
		} else if (
			!value.isDone &&
			(!value.continueCursor || value.continueCursor === interval.cursor)
		) {
			return failPagination(state, new Error('Non-progressing pagination cursor'))
		}
	}
	return changed ? { ...state, next, order, intervals } : state
}
export function paginationView<Page extends ListPage>(state: PaginationState<Page>) {
	const rows: Page['page'][number][] = []
	let latest: Page | undefined
	let loading = false
	for (const key of state.order) {
		const interval = state.intervals[key]
		if (!interval.value) {
			loading = true
			break
		}
		rows.push(...interval.value.page)
		latest = interval.value
	}
	const splitting = Object.values(state.intervals).some(
		(interval) => interval.children !== undefined,
	)
	return {
		rows,
		completeness: latest?.completeness,
		isLoading: !state.error && loading && latest === undefined,
		isFetchingNextPage: !state.error && ((loading && latest !== undefined) || splitting),
		hasNextPage: !state.error && !loading && !splitting && latest !== undefined && !latest.isDone,
	}
}
export function nextPagination<Page extends ListPage>(
	state: PaginationState<Page>,
): PaginationState<Page> {
	if (!paginationView(state).hasNextPage) return state
	const lastKey = state.order[state.order.length - 1]
	const last = state.intervals[lastKey]
	const endCursor = last.endCursor ?? last.value!.continueCursor
	const key = `${state.epoch}:${state.next}`
	return {
		...state,
		next: state.next + 1,
		order: [...state.order, key],
		intervals: {
			...state.intervals,
			// Fixed adjacent ranges keep reactive inserts/deletes from moving rows across a loaded boundary.
			[lastKey]: { ...last, endCursor },
			[key]: { cursor: endCursor },
		},
	}
}
