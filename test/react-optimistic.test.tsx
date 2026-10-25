// @vitest-environment jsdom
import { act } from 'react-dom/test-utils'
import { ConvexReactClient } from 'convex/react'
import type { OptimisticLocalStore } from 'convex/browser'
import { makeFunctionReference, type PaginationOptions } from 'convex/server'
import { describe, expect, it } from 'vite-plus/test'
import { defineOptimisticList, type OptimisticListDescriptor } from '../src/react'
import { evaluateFilter, type FilterAst } from '../src/filters'

type Row = { id: string; title: string; status: string; score?: number; secret?: string }
type Page = {
	page: Row[]
	continueCursor: string
	isDone: boolean
	splitCursor?: string
	pageStatus?: 'SplitRequired'
	completeness: string
	opaque: string
}
type Args = { status: string; session: string; paginationOpts: PaginationOptions }
const query = makeFunctionReference<'query', Args, Page>('optimism:list')
const mutation = makeFunctionReference<'mutation', { id: string }, null>('optimism:save')
const row = (id: string, score = 1): Row => ({ id, title: id, status: 'open', score })
const args = (
	status = 'open',
	cursor: string | null = null,
	numItems = 2,
	session = 'one',
): Args => ({ status, session, paginationOpts: { cursor, numItems } })
const page = (rows: Row[], cursor = 'opaque:next', extra: Partial<Page> = {}): Page => ({
	page: rows,
	continueCursor: cursor,
	isDone: false,
	completeness: 'row-budget',
	opaque: 'untouched',
	...extra,
})
const predicate = (status: string): FilterAst => ({
	kind: 'scalar',
	field: 'status',
	operator: 'eq',
	value: status,
})
const descriptor: OptimisticListDescriptor<typeof query, 'title' | 'status' | 'score' | 'secret'> =
	{
		id: 'id',
		writable: ['title', 'status', 'score', 'secret'],
		fields: () => ['id', 'title', 'status', 'score', 'secret'],
		session: (a) => a.session,
		membership: (a) => ({ predicate: predicate(a.status), complete: true }),
		order: () => [
			{ field: 'score', direction: 'asc' },
			{ field: 'id', direction: 'asc' },
		],
		interval: (a) =>
			a.paginationOpts.cursor === null
				? { lower: null, upper: [5, 'z'] }
				: a.paginationOpts.cursor === 'opaque:next'
					? { lower: [5, 'z'], upper: [10, 'z'] }
					: undefined,
	}
// Reuses U9's documented transport-only pattern. The public Convex client owns
// all query caching, OptimisticLocalStore operations, replay, rebase and rollback.
class Socket {
	static latest: Socket
	onopen: (() => void) | null = null
	onmessage: ((m: { data: string }) => void) | null = null
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
	receive(frame: any) {
		this.onmessage?.({ data: JSON.stringify(frame) })
	}
}
const ts = (n: number) => Buffer.from([n, 0, 0, 0, 0, 0, 0, 0]).toString('base64')
async function fixture(inputs: { args: Args; value?: Page }[]) {
	const client = new ConvexReactClient('https://u10-fixture.convex.cloud', {
		// SAFETY: only the WebSocket transport is substituted; the actual public client executes optimism.
		webSocketConstructor: Socket as never,
		unsavedChangesWarning: false,
		logger: false,
	})
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
	const watches = inputs.map(({ args: a }) => client.watchQuery(query, a))
	const stops = watches.map((watch) => watch.onUpdate(() => {}))
	client.connectionState()
	const socket = Socket.latest
	socket.onopen?.()
	let version = { querySet: 0, identity: 0, ts: ts(0) },
		tick = 0
	async function deliver(values: { index: number; value: Page }[]) {
		const adds = socket.sent
			.filter((m) => m.type === 'ModifyQuerySet')
			.flatMap((m) => m.modifications)
			.filter((m) => m.type === 'Add')
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
				modifications: values.map(({ index, value }) => ({
					type: 'QueryUpdated',
					queryId: adds[index].queryId,
					value,
					logLines: [],
					journal: null,
				})),
			}),
		)
		version = next
	}
	await deliver(
		inputs.flatMap((input, index) => (input.value ? [{ index, value: input.value }] : [])),
	)
	const pending = new Map<number, Promise<any>>()
	return {
		socket,
		deliver,
		read: (i: number) => watches[i].localQueryResult(),
		async update(update: (store: OptimisticLocalStore) => void) {
			let promise!: Promise<any>
			await act(async () => {
				promise = client.mutation(mutation, { id: 'a' }, { optimisticUpdate: update })
				promise.catch(() => {})
			})
			const requestId = socket.sent.filter((m) => m.type === 'Mutation').at(-1).requestId
			pending.set(requestId, promise)
			return requestId
		},
		async settle(
			requestId: number,
			success: boolean,
			values: { index: number; value: Page }[] = [],
		) {
			await act(async () =>
				socket.receive({
					type: 'MutationResponse',
					requestId,
					success,
					result: success ? null : 'rejected',
					ts: ts(tick + 1),
					logLines: [],
				}),
			)
			if (success) await deliver(values)
			await act(async () => {
				if (success) expect(await pending.get(requestId)).toBeNull()
				else await expect(pending.get(requestId)).rejects.toThrow('rejected')
			})
		},
		async close() {
			stops.forEach((stop) => stop())
			await client.close()
		},
	}
}
describe('conservative optimism through public Convex local store', () => {
	it('updates every loaded filtered/page-size/session copy and removes only definite false membership', async () => {
		const f = await fixture([
			{ args: args(), value: page([row('a'), row('b', 2)]) },
			{
				args: args('done', null, 5),
				value: page([
					{ ...row('a'), status: 'done' },
					{ ...row('c'), status: 'done' },
				]),
			},
			{ args: args('open', 'opaque:next', 7), value: page([row('a'), row('d', 8)]) },
			{ args: args('open', null, 8, 'two'), value: page([row('a')]) },
			{ args: args('open', 'loading') },
		])
		try {
			const list = defineOptimisticList(query, descriptor)
			await f.update((store) => list.patch(store, 'a', { title: 'edited' }))
			for (const i of [0, 1, 2, 3]) expect(f.read(i)?.page[0].title).toBe('edited')
			await f.update((store) => list.patch(store, 'a', { status: 'done' }))
			expect(f.read(0)?.page).toEqual([row('b', 2)])
			expect(f.read(2)?.page).toEqual([row('d', 8)])
			expect(f.read(1)?.page).toEqual([
				{ ...row('a'), status: 'done', title: 'edited' },
				{ ...row('c'), status: 'done' },
			])
			expect(f.read(4)).toBeUndefined()
		} finally {
			await f.close()
		}
	})
	it('keeps unknown membership/rank and never materializes absent privileged or protected fields', async () => {
		const original = { id: 'a', title: 'a', status: 'open' }
		const f = await fixture([{ args: args(), value: page([original, row('b', 2)]) }])
		try {
			const list = defineOptimisticList(query, {
				...descriptor,
				membership: () => ({
					predicate: { kind: 'relation', name: 'private', mode: 'some', predicate: null },
					complete: false,
				}),
			})
			await f.update((store) => {
				list.patch(store, 'a', { title: 'safe', score: 9, secret: 'leak' })
				list.insert(store, row('new', 3))
			})
			expect(f.read(0)?.page).toEqual([{ ...original, title: 'safe' }, row('b', 2)])
			const hidden = defineOptimisticList(query, {
				...descriptor,
				membership: () => ({
					predicate: { kind: 'scalar', field: 'secret', operator: 'eq', value: 'yes' },
					complete: true,
				}),
			})
			await f.update((store) => hidden.patch(store, 'a', { secret: 'no' }))
			expect(f.read(0)?.page[0]).toEqual({ ...original, title: 'safe' })
			// The same U7 evaluator supplies unknown, without treating a missing field as null/false.
			expect(
				evaluateFilter(
					{ kind: 'scalar', field: 'secret', operator: 'eq', value: 'yes' },
					original,
					new Set(Object.keys(original)),
				),
			).toBe('unknown')
		} finally {
			await f.close()
		}
	})
	it('inserts once into a known interval, deduplicates IDs and preserves every metadata value', async () => {
		const first = page([row('a'), row('a')], 'protected:first', {
			splitCursor: 'protected:split',
			pageStatus: 'SplitRequired',
		})
		const second = page([row('b', 8)], 'protected:second')
		const f = await fixture([
			{ args: args(), value: first },
			{ args: args('open', 'opaque:next'), value: second },
			{ args: args('open', 'unloaded') },
		])
		try {
			const list = defineOptimisticList(query, descriptor)
			await f.update((store) => {
				list.insert(store, row('new', 7))
				list.insert(store, row('new', 7))
				list.insert(store, row('outside', 20))
			})
			expect(f.read(0)?.page).toEqual([row('a')])
			expect(f.read(1)?.page).toEqual([row('new', 7), row('b', 8)])
			for (const [i, original] of [
				[0, first],
				[1, second],
			] as const) {
				const { page: _rows, ...metadata } = f.read(i)!
				const { page: _originalRows, ...expected } = original
				expect(metadata).toEqual(expected)
			}
			expect(f.read(2)).toBeUndefined()
		} finally {
			await f.close()
		}
	})
	it('moves across pages, preserves outside/ambiguous placement, and deletes overlapping split copies', async () => {
		const f = await fixture([
			{ args: args(), value: page([row('a'), row('b', 3)]) },
			{ args: args('open', 'opaque:next'), value: page([row('c', 8)]) },
			{
				args: { ...args(), paginationOpts: { cursor: null, endCursor: 'split', numItems: 1 } },
				value: page([row('a')]),
			},
		])
		try {
			const list = defineOptimisticList(query, descriptor)
			await f.update((store) => list.patch(store, 'a', { score: 7 }))
			expect(f.read(0)?.page).toEqual([row('b', 3)])
			expect(f.read(2)?.page).toEqual([])
			expect(f.read(1)?.page).toEqual([row('a', 7), row('c', 8)])
			await f.update((store) => list.patch(store, 'a', { score: 30, title: 'outside' }))
			expect(f.read(1)?.page).toEqual([{ ...row('a', 30), title: 'outside' }, row('c', 8)])
			await f.update((store) => list.insert(store, row('ambiguous', 2)))
			expect(f.read(0)?.page).toEqual([row('b', 3)])
			await f.update((store) => list.delete(store, 'a'))
			expect(f.read(1)?.page).toEqual([row('c', 8)])
			expect(f.read(0)?.continueCursor).toBe('opaque:next')
		} finally {
			await f.close()
		}
	})
	it('replays/rebases concurrent mutations and rolls back failure and confirmed success', async () => {
		const f = await fixture([{ args: args(), value: page([row('a')]) }])
		try {
			const list = defineOptimisticList(query, descriptor)
			let replays = 0
			const title = await f.update((store) => {
				replays++
				list.patch(store, 'a', { title: 'pending' })
			})
			const status = await f.update((store) => list.patch(store, 'a', { score: 2 }))
			await f.deliver([{ index: 0, value: page([{ ...row('a'), title: 'remote' }]) }])
			expect(replays).toBeGreaterThan(1)
			expect(f.read(0)?.page).toEqual([{ ...row('a', 2), title: 'pending' }])
			await f.settle(title, false)
			expect(f.read(0)?.page).toEqual([{ ...row('a', 2), title: 'remote' }])
			await f.settle(status, true, [
				{ index: 0, value: page([{ ...row('a', 4), title: 'confirmed' }]) },
			])
			expect(f.read(0)?.page).toEqual([{ ...row('a', 4), title: 'confirmed' }])
		} finally {
			await f.close()
		}
	})
})

it('does not infer insertion from incomplete logic or change unknown intervals, including duplicate rows', async () => {
	const initial = page([row('a'), row('a')])
	const f = await fixture([
		{ args: args(), value: initial },
		{ args: args('open', 'unknown'), value: page([row('b', 8)]) },
	])
	try {
		const incomplete = defineOptimisticList(query, {
			...descriptor,
			membership: (a) => ({ predicate: predicate(a.status), complete: false }),
		})
		await f.update((store) => incomplete.insert(store, row('new', 2)))
		expect(f.read(0)).toEqual(initial)
		expect(f.read(1)?.page).toEqual([row('b', 8)])
		const known = defineOptimisticList(query, descriptor)
		await f.update((store) => known.insert(store, row('outside', 20)))
		expect(f.read(0)).toEqual(initial)
		expect(f.read(1)?.page).toEqual([row('b', 8)])
	} finally {
		await f.close()
	}
})
it('uses total descending order and refuses a rank when a visible neighbor has a protected key', async () => {
	const f = await fixture([{ args: args(), value: page([row('a', 4), row('b', 1)]) }])
	try {
		const descending = defineOptimisticList(query, {
			...descriptor,
			order: () => [
				{ field: 'score', direction: 'desc' },
				{ field: 'id', direction: 'asc' },
			],
			interval: () => ({ lower: null, upper: null }),
		})
		await f.update((store) => descending.insert(store, row('new', 3)))
		expect(f.read(0)?.page).toEqual([row('a', 4), row('new', 3), row('b', 1)])
		await f.deliver([
			{
				index: 0,
				value: page([row('a', 4), { id: 'hidden', title: 'hidden', status: 'open' }, row('b', 1)]),
			},
		])
		// Pending insertion is replayed; a neighbor's newly hidden sort value makes rank unknown.
		expect(f.read(0)?.page.map((r) => r.id)).toEqual(['a', 'hidden', 'b'])
		await f.update((store) => descending.patch(store, 'b', { score: 5 }))
		expect(f.read(0)?.page.map((r) => r.id)).toEqual(['a', 'hidden', 'b'])
		expect(f.read(0)?.page[2].score).toBe(5)
	} finally {
		await f.close()
	}
})
it('never copies a group field into another output projection during a cross-page move', async () => {
	const f = await fixture([
		{ args: args(), value: page([{ ...row('a'), secret: 'privileged' }]) },
		{ args: args('open', 'opaque:next'), value: page([row('b', 8)]) },
	])
	try {
		const list = defineOptimisticList(query, {
			...descriptor,
			fields: (a) =>
				a.paginationOpts.cursor === null
					? ['id', 'title', 'status', 'score', 'secret']
					: ['id', 'title', 'status', 'score'],
		})
		await f.update((store) => list.patch(store, 'a', { score: 7 }))
		expect(f.read(0)?.page).toEqual([])
		expect(f.read(1)?.page).toEqual([row('a', 7), row('b', 8)])
		expect(Object.hasOwn(f.read(1)!.page[0], 'secret')).toBe(false)
	} finally {
		await f.close()
	}
})
it('treats a protected sort field as unknown even when a caller supplies its value', async () => {
	const initial = page([row('a', 1), row('b', 2)])
	const f = await fixture([{ args: args(), value: initial }])
	try {
		const list = defineOptimisticList(query, {
			...descriptor,
			fields: () => ['id', 'title', 'status', 'score'],
			order: () => [
				{ field: 'secret', direction: 'asc' },
				{ field: 'id', direction: 'asc' },
			],
			interval: () => ({ lower: null, upper: null }),
		})
		await f.update((store) => list.insert(store, { ...row('new'), secret: 'supplied' }))
		expect(f.read(0)).toEqual(initial)
		await f.update((store) =>
			list.patch(store, 'a', { title: 'safe', score: 20, secret: 'supplied' }),
		)
		expect(f.read(0)?.page).toEqual([{ ...row('a', 20), title: 'safe' }, row('b', 2)])
		expect(Object.hasOwn(f.read(0)!.page[0], 'secret')).toBe(false)
	} finally {
		await f.close()
	}
})

it('preserves an existing destination copy rather than borrowing absent fields from a richer copy', async () => {
	const f = await fixture([
		{ args: args(), value: page([{ ...row('a'), secret: 'privileged' }]) },
		{ args: args('open', 'opaque:next'), value: page([row('a'), row('b', 8)]) },
	])
	try {
		const list = defineOptimisticList(query, descriptor)
		await f.update((store) => list.patch(store, 'a', { score: 7, title: 'safe' }))
		expect(f.read(0)?.page).toEqual([])
		expect(f.read(1)?.page).toEqual([{ ...row('a', 7), title: 'safe' }, row('b', 8)])
		expect(Object.hasOwn(f.read(1)!.page[0], 'secret')).toBe(false)
	} finally {
		await f.close()
	}
})

it('preserves overlapping copies when one interval cannot establish neighbor ordering', async () => {
	const hidden = { id: 'hidden', title: 'hidden', status: 'open' }
	const f = await fixture([
		{ args: args(), value: page([row('a'), row('b', 4)]) },
		{ args: args('open', null, 3), value: page([row('a'), hidden]) },
	])
	try {
		const list = defineOptimisticList(query, {
			...descriptor,
			interval: () => ({ lower: null, upper: null }),
		})
		await f.update((store) => list.patch(store, 'a', { score: 3 }))
		expect(f.read(0)?.page).toEqual([row('a', 3), row('b', 4)])
		expect(f.read(1)?.page).toEqual([row('a', 3), hidden])
	} finally {
		await f.close()
	}
})

it('does not fill a destination copy missing its protected membership or order field', async () => {
	for (const field of ['score', 'secret'] as const) {
		const destination = { ...row('a') }
		delete destination[field]
		const f = await fixture([
			{ args: args(), value: page([{ ...row('a'), secret: 'privileged' }]) },
			{ args: args('open', 'opaque:next'), value: page([destination, row('b', 8)]) },
		])
		try {
			const list = defineOptimisticList(query, {
				...descriptor,
				membership: () => ({
					predicate:
						field === 'secret'
							? { kind: 'scalar', field: 'secret', operator: 'eq', value: 'privileged' }
							: predicate('open'),
					complete: true,
				}),
			})
			await f.update((store) => list.patch(store, 'a', { score: 7, title: 'safe' }))
			expect(f.read(0)?.page).toEqual([{ ...row('a', 7), title: 'safe', secret: 'privileged' }])
			const expected = { ...destination, title: 'safe' }
			if (field === 'secret') expected.score = 7
			expect(f.read(1)?.page).toEqual([expected, row('b', 8)])
			expect(Object.hasOwn(f.read(1)!.page[0], field)).toBe(false)
		} finally {
			await f.close()
		}
	}
})
