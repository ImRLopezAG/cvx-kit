// @vitest-environment jsdom
import { createElement, memo, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { makeFunctionReference } from 'convex/server'
import { describe, expect, it } from 'vite-plus/test'
import { combineErrorContracts, defineErrorContract } from '../src/errors'
import { useCommand, type Command } from '../src/react'

const errors = defineErrorContract({ CONFLICT: { message: 'Changed', details: {} } })
const commandErrors = combineErrorContracts(
	errors,
	defineErrorContract({ DENIED: { message: 'Denied', details: {} } }),
)
const mutation = makeFunctionReference<'mutation', { amount: number }, { saved: number }>(
	'commands:save',
)
const query = makeFunctionReference<'query', {}, number>('commands:value')
type ServerVersion = { querySet: number; identity: number; ts: string }
type ServerFrame =
	| {
			type: 'Transition'
			startVersion: ServerVersion
			endVersion: ServerVersion
			modifications: {
				type: 'QueryUpdated'
				queryId: number
				value: number
				logLines: string[]
				journal: null
			}[]
	  }
	| {
			type: 'MutationResponse'
			requestId: number
			success: boolean
			result: string | { saved: number }
			ts?: string
			logLines: string[]
			errorData?: ReturnType<typeof errors.project>
	  }
// Transport fixture only: all optimistic execution, rebase and rollback run in the installed Convex client.
class Socket {
	static latest: Socket
	onopen: (() => void) | null = null
	onmessage: ((message: { data: string }) => void) | null = null
	onclose: (() => void) | null = null
	onerror: (() => void) | null = null
	readyState = 1
	sent: {
		type: string
		requestId: number
		modifications: { queryId: number }[]
		newVersion: number
	}[] = []
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
	receive(message: ServerFrame) {
		this.onmessage?.({ data: JSON.stringify(message) })
	}
}
function timestamp(n: number) {
	return Buffer.from([n, 0, 0, 0, 0, 0, 0, 0]).toString('base64')
}

async function fixture(
	renderCommand?: (command: Command<typeof mutation, typeof commandErrors>) => ReactNode,
) {
	// SAFETY: the fixture implements the WebSocket event/send surface used by Convex; no network connection is opened.
	const client = new ConvexReactClient('https://u8-proof.convex.cloud', {
		webSocketConstructor: Socket as never,
		unsavedChangesWarning: false,
		logger: false,
	})
	const watch = client.watchQuery(query, {})
	const unsubscribe = watch.onUpdate(() => {})
	const socket = Socket.latest
	socket.onopen?.()
	const modification = socket.sent.find((message) => message.type === 'ModifyQuerySet')!
	const queryId = modification.modifications[0].queryId
	let version = { querySet: 0, identity: 0, ts: timestamp(0) }
	const transition = (value: number | undefined, ts: number) => {
		const next = { querySet: modification.newVersion, identity: 0, ts: timestamp(ts) }
		socket.receive({
			type: 'Transition',
			startVersion: version,
			endVersion: next,
			modifications:
				value === undefined
					? []
					: [{ type: 'QueryUpdated', queryId, value, logLines: [], journal: null }],
		})
		version = next
	}
	transition(10, 1)
	let calls = 0
	const optimisticUpdate = (
		store: import('convex/browser').OptimisticLocalStore,
		args: { amount: number },
	) => {
		calls++
		const value = store.getQuery(query, {})
		if (value !== undefined) store.setQuery(query, {}, value + args.amount)
	}
	let command: Command<typeof mutation, typeof commandErrors> | undefined
	function Probe() {
		command = useCommand(mutation, { errors: commandErrors, optimisticUpdate })
		return renderCommand?.(command) ?? null
	}
	const container = document.createElement('div')
	if (renderCommand) document.body.append(container)
	const root = createRoot(container)
	// React's act gate is explicit and applies to React 18 and 19.
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
	await act(async () => {
		root.render(createElement(ConvexProvider, { client }, createElement(Probe)))
	})
	return {
		client,
		socket,
		watch,
		transition,
		command: () => command!,
		calls: () => calls,
		async rerender() {
			await act(async () => {
				root.render(createElement(ConvexProvider, { client }, createElement(Probe)))
			})
		},
		async close() {
			await act(async () => root.unmount())
			container.remove()
			unsubscribe()
			await client.close()
		},
	}
}

describe('useCommand with the real Convex optimistic lifecycle', () => {
	it('updates memoized consumers and preserves previous command state snapshots', async () => {
		const View = memo(({ command }: { command: Command<typeof mutation, typeof commandErrors> }) =>
			createElement(
				'output',
				{ id: 'command-state' },
				JSON.stringify({
					pending: command.isPending,
					result: command.result,
				}),
			),
		)
		const f = await fixture((command) => createElement(View, { command }))
		try {
			const initial = f.command()
			let pending!: ReturnType<typeof initial>
			await act(async () => {
				pending = initial({ amount: 2 })
			})
			expect(document.querySelector('#command-state')?.textContent).toBe(
				JSON.stringify({ pending: true }),
			)
			expect(initial.isPending).toBe(false)
			const active = f.command()
			const request = f.socket.sent.find((message) => message.type === 'Mutation')!
			await act(async () => {
				f.socket.receive({
					type: 'MutationResponse',
					requestId: request.requestId,
					success: true,
					result: { saved: 12 },
					ts: timestamp(2),
					logLines: [],
				})
				f.transition(12, 2)
				await pending
			})
			expect(document.querySelector('#command-state')?.textContent).toBe(
				JSON.stringify({
					pending: false,
					result: { ok: true, value: { saved: 12 } },
				}),
			)
			expect(active.isPending).toBe(true)
			expect(active.result).toBeUndefined()
		} finally {
			await f.close()
		}
	})
	it('attaches without manual invocation, permits pending replay, commits success and exposes typed state', async () => {
		const f = await fixture()
		try {
			expect(f.calls()).toBe(0)
			let pending!: ReturnType<ReturnType<typeof f.command>>
			await act(async () => {
				pending = f.command()({ amount: 2 })
			})
			expect(f.command().isPending).toBe(true)
			expect(f.calls()).toBe(1)
			expect(f.watch.localQueryResult()).toBe(12)
			await f.rerender()
			expect(f.calls()).toBe(1)
			await act(async () => f.transition(20, 2))
			expect(f.calls()).toBe(2)
			expect(f.watch.localQueryResult()).toBe(22)
			const request = f.socket.sent.find((message) => message.type === 'Mutation')!
			await act(async () => {
				f.socket.receive({
					type: 'MutationResponse',
					requestId: request.requestId,
					success: true,
					result: { saved: 22 },
					ts: timestamp(3),
					logLines: [],
				})
				f.transition(22, 3)
				expect(await pending).toEqual({ ok: true, value: { saved: 22 } })
			})
			expect(f.command().isPending).toBe(false)
			expect(f.command().result).toEqual({ ok: true, value: { saved: 22 } })
			const calls = f.calls()
			await act(async () => f.transition(30, 4))
			expect(f.watch.localQueryResult()).toBe(30)
			expect(f.calls()).toBe(calls)
		} finally {
			await f.close()
		}
	})
	it('rolls back declared and network failures, retaining pending state and the newest concurrent result', async () => {
		const f = await fixture()
		try {
			let first!: ReturnType<ReturnType<typeof f.command>>
			let second!: ReturnType<ReturnType<typeof f.command>>
			await act(async () => {
				first = f.command()({ amount: 2 })
				second = f.command()({ amount: 3 })
			})
			expect(f.watch.localQueryResult()).toBe(15)
			const requests = f.socket.sent.filter((message) => message.type === 'Mutation')
			const envelope = errors.project(errors.create('CONFLICT', {}))
			await act(async () => {
				f.socket.receive({
					type: 'MutationResponse',
					requestId: requests[1].requestId,
					success: false,
					result: 'private-diagnostic',
					errorData: envelope,
					logLines: [],
				})
				expect(await second).toEqual({ ok: false, failure: envelope })
			})
			expect(f.watch.localQueryResult()).toBe(12)
			expect(f.command().isPending).toBe(true)
			await act(async () => {
				f.socket.receive({
					type: 'MutationResponse',
					requestId: requests[0].requestId,
					success: false,
					result: 'private-network',
					logLines: [],
				})
				expect(await first).toEqual({ ok: false, failure: { _tag: 'UnknownFailure', version: 1 } })
			})
			expect(f.watch.localQueryResult()).toBe(10)
			expect(f.command().isPending).toBe(false)
			expect(f.command().result).toEqual({ ok: false, failure: envelope })
			const calls = f.calls()
			await act(async () => f.transition(40, 4))
			expect(f.watch.localQueryResult()).toBe(40)
			expect(f.calls()).toBe(calls)
		} finally {
			await f.close()
		}
	})
})
