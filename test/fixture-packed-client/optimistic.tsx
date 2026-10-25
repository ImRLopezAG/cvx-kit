import { makeFunctionReference, type PaginationOptions } from 'convex/server'
import { useMutation } from 'convex/react'
import { defineOptimisticList, useCommand } from '../../src/react'
import { defineErrorContract } from '../../src/errors'
import type { OptimisticLocalStore } from 'convex/browser'
type Dto = { id: string; title: string; rank: number; status: 'open' | 'done' }
type Args = { status: 'open' | 'done'; session: string; paginationOpts: PaginationOptions }
const reference = makeFunctionReference<
	'query',
	Args,
	{ page: Dto[]; continueCursor: string; isDone: boolean }
>('tasks:list')
const mutation = makeFunctionReference<'mutation', { id: string; title: string }, null>(
	'tasks:rename',
)
// Export from the same browser-safe module used by the server endpoint, adjacent
// to its public output descriptor. It must describe the endpoint's real semantics.
export const list = defineOptimisticList(reference, {
	id: 'id',
	writable: ['title', 'status', 'rank'],
	fields: () => ['id', 'title', 'rank', 'status'],
	session: (args) => args.session,
	membership: (args) => ({
		complete: true,
		predicate: { kind: 'scalar', field: 'status', operator: 'eq', value: args.status },
	}),
	order: () => [
		{ field: 'rank', direction: 'asc' },
		{ field: 'id', direction: 'asc' },
	],
	// Only attest the entire list for a complete first-page response. A partial
	// response needs independent public interval information from the endpoint.
	interval: (args, page) =>
		args.paginationOpts.cursor === null && page.isDone ? { lower: null, upper: null } : undefined,
})
const errors = defineErrorContract({ DENIED: { message: 'Denied', details: {} } })
export function Probe() {
	const update = (store: OptimisticLocalStore, args: { id: string; title: string }) => {
		list.patch(store, args.id, { title: args.title })
	}
	const native = useMutation(mutation).withOptimisticUpdate(update)
	const command = useCommand(mutation, { errors, optimisticUpdate: update })
	void [native, command]
	return null
}
export function types(store: OptimisticLocalStore) {
	list.patch(store, 'one', { status: 'done', rank: 3 })
	list.insert(store, { id: 'one', title: 'One', rank: 1, status: 'open' })
	list.delete(store, 'one')
	// @ts-expect-error IDs retain the actual DTO ID type, rather than accepting any other field's value.
	list.delete(store, 123)
	// @ts-expect-error Patches use the actual projected DTO field type.
	list.patch(store, 'one', { rank: '3' })
	// @ts-expect-error Undeclared writable fields cannot be patched, including ID.
	list.patch(store, 'one', { id: 'other' })
	// @ts-expect-error A storage-only field is not in the public DTO.
	list.patch(store, 'one', { privateNote: 'secret' })
	// @ts-expect-error Insert requires a complete DTO, including its order key.
	list.insert(store, { id: 'one', title: 'One', status: 'open' })
	defineOptimisticList(reference, {
		id: 'id',
		// @ts-expect-error The output descriptor can only name projected DTO fields.
		writable: ['privateNote'],
		fields: () => [],
		session: () => null,
		membership: () => ({ predicate: { kind: 'and', children: [] }, complete: false }),
	})
}
