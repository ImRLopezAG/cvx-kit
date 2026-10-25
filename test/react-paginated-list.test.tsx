// @vitest-environment jsdom
import { Component, createElement, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import type { Value } from 'convex/values'
import { makeFunctionReference, type PaginationOptions } from 'convex/server'
import { describe, expect, it } from 'vite-plus/test'
import { queryErrors, usePaginatedList } from '../src/react'

type Page = {
	paginationMode?: 'native-search'
	page: { id: string }[]
	continueCursor: string
	isDone: boolean
	completeness: 'complete' | 'row-budget'
	splitCursor?: string
	pageStatus?: 'SplitRequired' | 'SplitRecommended'
}
type Args = {
	filters?: { a?: number; b?: number; ids?: number[] }
	order?: 'asc' | 'desc'
	paginationOpts: PaginationOptions
}
const query = makeFunctionReference<'query', Args, Page>('list:one')
const other = makeFunctionReference<'query', Args, Page>('list:two')
type BoundaryState = { error?: Error }
class Boundary extends Component<{ children?: ReactNode }, BoundaryState> {
	state: BoundaryState = {}
	static getDerivedStateFromError(error: Error) {
		return { error }
	}
	render() {
		return this.state.error ? createElement('output', {}, 'caught') : this.props.children
	}
}
type ServerFrame = {
	type: 'Transition'
	startVersion: { querySet: number; identity: number; ts: string }
	endVersion: { querySet: number; identity: number; ts: string }
	modifications: any[]
}
// Transport only: subscriptions, caching, error decoding and lifecycle execute in the actual public Convex client.
class Socket {
	static latest: Socket
	onopen: (() => void) | null = null
	onmessage: ((message: { data: string }) => void) | null = null
	onclose: (() => void) | null = null
	onerror: (() => void) | null = null
	readyState = 1
	sent: any[] = []
	constructor() {
		Socket.latest = this
	}
	send(data: string) {
		this.sent.push(JSON.parse(data))
	}
	close() {
		this.readyState = 3
		this.onclose?.()
	}
	receive(frame: ServerFrame) {
		this.onmessage?.({ data: JSON.stringify(frame) })
	}
}
const ts = (n: number) => Buffer.from([n, 0, 0, 0, 0, 0, 0, 0]).toString('base64')
const page = (ids: string[], cursor: string, done = false, extra: Partial<Page> = {}): Page => ({
	page: ids.map((id) => ({ id })),
	continueCursor: cursor,
	isDone: done,
	completeness: 'complete',
	...extra,
})
async function fixture(
	initial: Omit<Args, 'paginationOpts'> | 'skip' = {},
	mode: 'restart' | 'throw' = 'restart',
	pageSize = 2,
) {
	const client = new ConvexReactClient('https://u9-fixture.convex.cloud', {
		// SAFETY: this fixture supplies only the WebSocket transport; Convex owns subscription execution.
		webSocketConstructor: Socket as never,
		unsavedChangesWarning: false,
		logger: false,
	})
	let args = initial,
		reference = query,
		identity: string | undefined
	let list!: ReturnType<typeof usePaginatedList<typeof query>>
	const renders: (typeof list)[] = []
	function Probe() {
		list = usePaginatedList(reference, args, {
			pageSize,
			onInvalidCursor: mode,
			resetIdentity: identity,
		})
		renders.push(list)
		return null
	}
	const container = document.createElement('div')
	document.body.append(container)
	const root = createRoot(container)
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
	const render = async () => {
		await act(async () =>
			root.render(
				createElement(
					ConvexProvider,
					{ client },
					createElement(Boundary, {}, createElement(Probe)),
				),
			),
		)
	}
	client.connectionState()
	await render()
	const socket = Socket.latest
	socket.onopen?.()
	let version = { querySet: 0, identity: 0, ts: ts(0) },
		tick = 0
	const adds = () =>
		socket.sent
			.filter((m) => m.type === 'ModifyQuerySet')
			.flatMap((m) => m.modifications)
			.filter((m) => m.type === 'Add')
	const active = () => {
		const map = new Map<number, any>()
		for (const m of socket.sent
			.filter((m) => m.type === 'ModifyQuerySet')
			.flatMap((m) => m.modifications)) {
			if (m.type === 'Add') map.set(m.queryId, m)
			else map.delete(m.queryId)
		}
		return [...map.values()]
	}
	const deliver = async (id: number, value: Page | Error | Value, error = false) => {
		const next = {
			querySet: socket.sent.filter((m) => m.type === 'ModifyQuerySet').at(-1)?.newVersion ?? 0,
			identity: 0,
			ts: ts(++tick),
		}
		await act(async () =>
			socket.receive({
				type: 'Transition',
				startVersion: version,
				endVersion: next,
				modifications: [
					error
						? {
								type: 'QueryFailed',
								queryId: id,
								errorMessage: 'InvalidCursor private diagnostics',
								errorData: value,
								logLines: [],
								journal: null,
							}
						: { type: 'QueryUpdated', queryId: id, value, logLines: [], journal: null },
				],
			}),
		)
		version = next
	}
	return {
		client,
		socket,
		adds,
		active,
		deliver,
		list: () => list,
		renders,
		container,
		async change(next: typeof args, nextRef = reference, nextIdentity = identity) {
			args = next
			reference = nextRef
			identity = nextIdentity
			await render()
		},
		async fetch() {
			await act(async () => {
				list.fetchNextPage()
				list.fetchNextPage()
			})
		},
		async close() {
			await act(async () => root.unmount())
			container.remove()
			await client.close()
		},
	}
}
const invalid = () => queryErrors.project(queryErrors.create('invalid-cursor', {}))
describe('usePaginatedList public Convex subscriptions', () => {
	it('pins loaded intervals so reactive insertion and deletion preserve all loaded rows', async () => {
		const f = await fixture()
		try {
			await f.deliver(f.adds()[0].queryId, page(['A', 'B'], 'B'))
			await f.fetch()
			const first = f.active().find((entry) => entry.args[0].paginationOpts.cursor === null)!
			const second = f.active().find((entry) => entry.args[0].paginationOpts.cursor === 'B')!
			expect(first.args[0].paginationOpts.endCursor).toBe('B')
			await f.deliver(first.queryId, page(['A', 'B'], 'B'))
			await f.deliver(second.queryId, page(['C', 'D'], 'D'))
			await f.deliver(first.queryId, page(['X', 'A', 'B'], 'B'))
			expect(f.list().rows.map((row) => row.id)).toEqual(['X', 'A', 'B', 'C', 'D'])
			await f.deliver(first.queryId, page(['B'], 'B'))
			expect(f.list().rows.map((row) => row.id)).toEqual(['B', 'C', 'D'])
		} finally {
			await f.close()
		}
	})
	it('nested required splits retain the entire fixed range before its following sibling', async () => {
		const f = await fixture()
		try {
			await f.deliver(
				f.adds()[0].queryId,
				page(['parent'], 'Z', false, {
					splitCursor: 'M',
					pageStatus: 'SplitRecommended',
				}),
			)
			const [left, right] = f.adds().slice(1)
			await f.deliver(
				left.queryId,
				page(['partial'], 'F', false, {
					splitCursor: 'C',
					pageStatus: 'SplitRequired',
					completeness: 'row-budget',
				}),
			)
			await f.deliver(right.queryId, page(['after-M'], 'Z'))
			const middle = f.active().find((entry) => entry.args[0].paginationOpts.cursor === 'C')!
			const start = f.active().find((entry) => entry.args[0].paginationOpts.endCursor === 'C')!
			expect(middle.args[0].paginationOpts.endCursor).toBe('M')
			await f.deliver(start.queryId, page(['through-C'], 'C'))
			await f.deliver(middle.queryId, page(['through-F', 'through-M'], 'M'))
			expect(f.list().rows.map((row) => row.id)).toEqual([
				'through-C',
				'through-F',
				'through-M',
				'after-M',
			])
		} finally {
			await f.close()
		}
	})
	it('skip unsubscribes; equivalent deep object keys keep the epoch, arrays/query/sort/auth changes clear immediately', async () => {
		const f = await fixture('skip')
		try {
			expect(f.adds()).toHaveLength(0)
			expect(f.list().isLoading).toBe(false)
			await f.change({ filters: { a: 1, b: 2, ids: [1, 2] } })
			const first = f.adds()[0]
			const key = f.list().resetKey
			await f.deliver(first.queryId, page(['private'], 'next'))
			await f.change({ filters: { ids: [1, 2], b: 2, a: 1 } })
			expect(f.adds()).toHaveLength(1)
			expect(f.list().resetKey).toBe(key)
			// SAFETY: these table rows pair valid args, reference and reset identity without changing their values.
			for (const [args, ref, identity] of [
				[{ filters: { ids: [2, 1], a: 1, b: 2 } }, query, undefined],
				[{ order: 'desc' }, query, undefined],
				[{}, other, undefined],
				[{}, other, 'signed-out'],
			] as [Omit<Args, 'paginationOpts'>, typeof query, string | undefined][]) {
				const previous = f.adds().at(-1)!
				await f.change(args, ref, identity)
				expect(f.list().rows).toEqual([])
				expect(f.list().completeness).toBeUndefined()
				await f.deliver(previous.queryId, page(['stale'], 'old'))
				expect(f.list().rows).toEqual([])
				await f.deliver(f.adds().at(-1)!.queryId, page(['private'], 'new'))
			}
			await f.change('skip')
			expect(f.active()).toHaveLength(0)
			expect(f.list().rows).toEqual([])
		} finally {
			await f.close()
		}
	})
	it('double fetch creates one interval, preserves duplicate relation edges and latest committed reason while loading', async () => {
		const f = await fixture()
		try {
			await f.deliver(
				f.adds()[0].queryId,
				page(['a', 'a'], 'next', false, { completeness: 'row-budget' }),
			)
			await f.fetch()
			// The first interval is resubscribed with its fixed end, alongside one new interval.
			expect(f.adds()).toHaveLength(3)
			expect(f.active()).toHaveLength(2)
			const first = f.active().find((entry) => entry.args[0].paginationOpts.cursor === null)!
			expect(first.args[0].paginationOpts.endCursor).toBe('next')
			expect(f.list().rows).toEqual([{ id: 'a' }, { id: 'a' }])
			expect(f.list().isFetchingNextPage).toBe(true)
			expect(f.list().completeness).toBe('row-budget')
			await f.deliver(
				f.adds().at(-1)!.queryId,
				page([], 'advances', false, { completeness: 'row-budget' }),
			)
			expect(f.list().hasNextPage).toBe(true)
			await f.fetch()
			expect(f.adds().at(-1)!.args[0].paginationOpts.cursor).toBe('advances')
			expect(f.active()).toHaveLength(3)
			await f.deliver(f.adds().at(-1)!.queryId, page([], 'end', true))
			expect(f.list().hasNextPage).toBe(false)
			expect(f.list().completeness).toBe('complete')
			await f.deliver(first.queryId, page(['updated'], 'next'))
			expect(f.list().rows).toEqual([{ id: 'updated' }])
		} finally {
			await f.close()
		}
	})
	for (const status of ['SplitRequired', 'SplitRecommended'] as const)
		it(`${status} retains parent until both interval children arrive`, async () => {
			const f = await fixture()
			try {
				await f.deliver(
					f.adds()[0].queryId,
					page(['a', 'b'], 'end', true, {
						splitCursor: 'mid',
						pageStatus: status,
						completeness: 'row-budget',
					}),
				)
				expect(f.adds()).toHaveLength(3)
				expect(f.list().rows).toEqual([{ id: 'a' }, { id: 'b' }])
				expect(f.list().completeness).toBe('row-budget')
				const [left, right] = f.adds().slice(1)
				expect(left.args[0].paginationOpts.endCursor).toBe('mid')
				expect(right.args[0].paginationOpts).toMatchObject({ cursor: 'mid', endCursor: 'end' })
				await f.deliver(right.queryId, page(['b'], 'end', true))
				expect(f.list().rows).toEqual([{ id: 'a' }, { id: 'b' }])
				await f.deliver(left.queryId, page(['a'], 'mid'))
				expect(f.active()).toHaveLength(2)
				expect(f.list().rows).toEqual([{ id: 'a' }, { id: 'b' }])
				expect(f.list().completeness).toBe('complete')
			} finally {
				await f.close()
			}
		})
	for (const split of [false, true])
		it(`invalid cursor ${split ? 'during split' : 'on page two'} restarts once then exposes failure`, async () => {
			const f = await fixture()
			try {
				await f.deliver(
					f.adds()[0].queryId,
					page(
						['private'],
						'next',
						false,
						split ? { splitCursor: 'mid', pageStatus: 'SplitRecommended' } : {},
					),
				)
				if (!split) await f.fetch()
				await f.deliver(f.adds().at(-1)!.queryId, invalid(), true)
				expect(f.list().rows).toEqual([])
				expect(f.list().completeness).toBeUndefined()
				expect(f.active()).toHaveLength(1)
				const fresh = f.adds().at(-1)!
				expect(fresh.args[0].paginationOpts.cursor).toBeNull()
				await f.deliver(fresh.queryId, invalid(), true)
				expect(f.list().failure).toEqual(invalid())
				expect(f.active()).toHaveLength(0)
				expect(f.list().isLoading).toBe(false)
				await f.change({}, query, 'new-user')
				expect(f.list().failure).toBeUndefined()
				expect(f.active()).toHaveLength(1)
			} finally {
				await f.close()
			}
		})
	it('revocation and unknown metadata clear privileged rows without classifying message text', async () => {
		for (const error of [
			queryErrors.project(queryErrors.create('FIELD_GROUP_DENIED', {})),
			{
				_tag: 'DeclaredFailure',
				version: 1,
				code: 'invalid-cursor',
				message: 'wrong',
				details: {},
			},
			{},
		]) {
			const f = await fixture()
			try {
				await f.deliver(f.adds()[0].queryId, page(['private'], 'next'))
				await f.fetch()
				const count = f.adds().length
				await f.deliver(f.adds().at(-1)!.queryId, error, true)
				expect(f.list().rows).toEqual([])
				expect(f.list().failure).toBeDefined()
				expect(f.adds()).toHaveLength(count)
				expect(f.active()).toHaveLength(0)
			} finally {
				await f.close()
			}
		}
	})
	it('explicit throw reaches boundary and unmount releases subscriptions', async () => {
		const f = await fixture({}, 'throw')
		try {
			await f.deliver(f.adds()[0].queryId, invalid(), true)
			expect(f.container.textContent).toBe('caught')
			expect(f.active()).toHaveLength(0)
		} finally {
			await f.close()
		}
	})
	it('page size rejects zero, fractions and values above the engine ceiling before subscribing', async () => {
		for (const size of [0, 1.5, 101]) {
			const f = await fixture({}, 'restart', size)
			try {
				expect(f.container.textContent).toBe('caught')
				expect(f.adds()).toHaveLength(0)
			} finally {
				await f.close()
			}
		}
	})
	it('old fetch callbacks cannot add intervals after reset, and unmount removes every subscription', async () => {
		const f = await fixture()
		try {
			await f.deliver(f.adds()[0].queryId, page(['one'], 'next'))
			const fetch = f.list().fetchNextPage
			await f.change({}, query, 'changed')
			const count = f.adds().length
			await act(async () => fetch())
			expect(f.adds()).toHaveLength(count)
			expect(f.list().rows).toEqual([])
		} finally {
			await f.close()
		}
		expect(f.active()).toHaveLength(0)
	})
	it('Convex optimistic rebase and rollback update the subscribed whole page', async () => {
		const f = await fixture()
		try {
			const first = f.adds()[0]
			await f.deliver(first.queryId, page(['server'], 'next'))
			let resolve!: () => void
			const observed = new Promise<void>((r) => (resolve = r))
			let pending!: Promise<any>
			await act(async () => {
				pending = f.client.mutation(
					makeFunctionReference<'mutation'>('list:update'),
					{},
					{
						optimisticUpdate: (store) => {
							const args = first.args[0]
							const value = store.getQuery(query, args)
							if (value) store.setQuery(query, args, { ...value, page: [{ id: 'optimistic' }] })
							resolve()
						},
					},
				)
				await observed
			})
			expect(f.list().rows).toEqual([{ id: 'optimistic' }])
			await f.deliver(first.queryId, page(['remote'], 'next'))
			expect(f.list().rows).toEqual([{ id: 'optimistic' }])
			const request = f.socket.sent.find((m) => m.type === 'Mutation')
			await act(async () => {
				f.socket.onmessage?.({
					data: JSON.stringify({
						type: 'MutationResponse',
						requestId: request.requestId,
						success: false,
						result: 'rejected',
						logLines: [],
					}),
				})
				await pending.catch(() => {})
			})
			expect(f.list().rows).toEqual([{ id: 'remote' }])
		} finally {
			await f.close()
		}
	})

	it('rejects nonprogressing split instead of looping', async () => {
		const f = await fixture()
		try {
			await f.deliver(
				f.adds()[0].queryId,
				page(['a'], 'same', false, { splitCursor: 'same', pageStatus: 'SplitRequired' }),
			)
			expect(f.list().failure).toBeDefined()
			expect(f.adds()).toHaveLength(1)
		} finally {
			await f.close()
		}
	})
})

describe('usePaginatedList native search transport', () => {
	it('adds only one successor and keeps its protected token when the parent grows and caps', async () => {
		const f = await fixture()
		try {
			const first = f.adds()[0]
			await f.deliver(
				first.queryId,
				page(['A', 'B'], 'sealed-2', false, { paginationMode: 'native-search' }),
			)
			await f.fetch()
			expect(f.adds()).toHaveLength(2)
			expect(f.active()[0]).toEqual(first)
			const child = f.adds()[1]
			expect(child.args[0].paginationOpts.cursor).toBe('sealed-2')
			expect(first.args[0].paginationOpts.endCursor).toBeUndefined()
			await f.deliver(
				child.queryId,
				page(['C'], 'sealed-3', false, { paginationMode: 'native-search' }),
			)
			await f.deliver(
				first.queryId,
				page(['X', 'A', 'B'], 'sealed-new-seen', true, { paginationMode: 'native-search' }),
			)
			expect(f.adds()).toHaveLength(2)
			expect(f.list().rows.map((row) => row.id)).toEqual(['X', 'A', 'B', 'C'])
			expect(f.list().hasNextPage).toBe(true)
			expect(f.active().find((entry) => entry.queryId === child.queryId).args).toEqual(child.args)
		} finally {
			await f.close()
		}
	})
	it('continues empty windows manually, rejects mixed modes and clears cached rows', async () => {
		const f = await fixture()
		try {
			await f.deliver(
				f.adds()[0].queryId,
				page([], 'empty-next', false, { paginationMode: 'native-search' }),
			)
			expect(f.adds()).toHaveLength(1)
			expect(f.list().hasNextPage).toBe(true)
			await f.fetch()
			expect(f.adds()).toHaveLength(2)
			await f.deliver(
				f.adds()[1].queryId,
				page(['private'], 'tail', false, { paginationMode: 'native-search' }),
			)
			expect(f.list().rows).toEqual([{ id: 'private' }])
			await f.deliver(f.adds()[0].queryId, page(['browse'], 'other'))
			expect(f.list().rows).toEqual([])
			expect(f.list().failure).toBeDefined()
			expect(f.active()).toHaveLength(0)
		} finally {
			await f.close()
		}
	})
	for (const extra of [
		{ pageStatus: 'SplitRequired' as const, splitCursor: 'mid' },
		{ completeness: 'searchSplitRequired' },
	])
		it('fails closed for search split protocol ' + JSON.stringify(extra), async () => {
			const f = await fixture()
			try {
				await f.deliver(
					f.adds()[0].queryId,
					// SAFETY: inject unsupported search completeness to test transported protocol rejection.
					page(['private'], 'next', false, {
						paginationMode: 'native-search',
						...extra,
					} as Partial<Page>),
				)
				expect(f.list().rows).toEqual([])
				expect(f.list().failure).toBeDefined()
				expect(f.active()).toHaveLength(0)
				expect(f.adds()).toHaveLength(1)
			} finally {
				await f.close()
			}
		})
})

it('resets search capability on identity changes and ignores late frames and fetch callbacks', async () => {
	const f = await fixture()
	try {
		const old = f.adds()[0]
		await f.deliver(
			old.queryId,
			page(['a', 'a'], 'search-token', false, { paginationMode: 'native-search' }),
		)
		expect(f.list().rows).toEqual([{ id: 'a' }, { id: 'a' }])
		const staleFetch = f.list().fetchNextPage
		await f.change({ filters: { a: 1 } })
		expect(f.list().rows).toEqual([])
		await f.deliver(
			old.queryId,
			page(['late'], 'late-token', false, { paginationMode: 'native-search' }),
		)
		await act(async () => staleFetch())
		expect(f.list().rows).toEqual([])
		const browse = f.adds().at(-1)!
		await f.deliver(browse.queryId, page(['browse'], 'browse-token'))
		await f.fetch()
		expect(
			f.active().find((entry) => entry.args[0].paginationOpts.cursor === null)!.args[0]
				.paginationOpts.endCursor,
		).toBe('browse-token')
		await f.change({}, query, 'new-search')
		expect(f.list().rows).toEqual([])
		await f.deliver(
			f.adds().at(-1)!.queryId,
			page(['search'], 'new-token', false, { paginationMode: 'native-search' }),
		)
		const count = f.adds().length
		await f.fetch()
		expect(f.adds()).toHaveLength(count + 1)
		await f.change('skip')
		expect(f.list().rows).toEqual([])
		expect(f.active()).toHaveLength(0)
	} finally {
		await f.close()
	}
})
