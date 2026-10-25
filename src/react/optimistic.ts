import type { OptimisticLocalStore } from 'convex/browser'
import type {
	FunctionArgs,
	FunctionReference,
	FunctionReturnType,
	PaginationOptions,
} from 'convex/server'
import { compareValues, convexToJson, type Value } from 'convex/values'
import { evaluateFilter } from '../querying/shared/evaluate'
import type { FilterAst } from '../querying/shared/ast'

type OptimisticQuery = FunctionReference<
	'query',
	'public',
	{ paginationOpts: PaginationOptions },
	{ page: Record<string, Value | undefined>[] }
>
type RowOf<Query extends OptimisticQuery> = FunctionReturnType<Query>['page'][number]
type FieldOf<Query extends OptimisticQuery> = keyof RowOf<Query> & string
export type OptimisticInterval = {
	/** Bounds in declared sort order: lower exclusive, upper inclusive. Null attests an unbounded side. */
	lower: readonly Value[] | null
	upper: readonly Value[] | null
}
export type OptimisticOrder<Field extends string> = readonly {
	field: Field
	direction: 'asc' | 'desc'
}[]
/** Shared server-owned semantics, never inferred from client filters or protected cursors. */
export type OptimisticListDescriptor<
	Query extends OptimisticQuery,
	Writable extends FieldOf<Query>,
	Id extends FieldOf<Query> = FieldOf<Query>,
> = {
	id: Id
	writable: readonly Writable[]
	/** Fields permitted by this args/session's output projection, including the ID. */
	fields: (args: FunctionArgs<Query>) => readonly FieldOf<Query>[]
	session: (args: FunctionArgs<Query>) => Value
	/** Known predicates may prove false even when other server logic remains undeclared. */
	membership: (args: FunctionArgs<Query>) => { predicate: FilterAst; complete: boolean }
	/** Complete, total server ordering, including tie breakers. Missing values remain unknown. */
	order?: (args: FunctionArgs<Query>) => OptimisticOrder<FieldOf<Query>>
	/** An attested loaded interval, not a decoded cursor or a guessed first-page range. */
	interval?: (
		args: FunctionArgs<Query>,
		page: FunctionReturnType<Query>,
	) => OptimisticInterval | undefined
}
export type OptimisticList<
	Query extends OptimisticQuery,
	Writable extends FieldOf<Query>,
	Id extends FieldOf<Query> = FieldOf<Query>,
> = {
	patch: (
		store: OptimisticLocalStore,
		id: RowOf<Query>[Id],
		patch: Partial<Pick<RowOf<Query>, Writable>>,
	) => void
	insert: (store: OptimisticLocalStore, row: RowOf<Query>) => void
	delete: (store: OptimisticLocalStore, id: RowOf<Query>[Id]) => void
}

/** Call synchronously inside withOptimisticUpdate/useCommand. Convex owns replay and rollback. */
export function defineOptimisticList<
	Query extends OptimisticQuery,
	Writable extends FieldOf<Query>,
	Id extends FieldOf<Query>,
>(
	reference: Query,
	descriptor: OptimisticListDescriptor<Query, Writable, Id>,
): OptimisticList<Query, Writable, Id> {
	type Row = RowOf<Query>
	type Change =
		| { kind: 'patch'; id: Row[Id]; patch: Partial<Pick<Row, Writable>> }
		| { kind: 'insert'; row: Row }
		| { kind: 'delete'; id: Row[Id] }
	function apply(store: OptimisticLocalStore, change: Change): void {
		const groups = new Map<
			string,
			{ args: FunctionArgs<Query>; value: FunctionReturnType<Query>; rows: Row[] }[]
		>()
		for (const { args, value } of store.getAllQueries(reference)) {
			if (value === undefined) continue
			const { paginationOpts: _pagination, ...rest } = args
			// SAFETY: Convex query arguments contain only Convex values; only pagination transport was omitted.
			const key = JSON.stringify(
				convexToJson([rest as Record<string, Value>, descriptor.session(args)]),
			)
			const group = groups.get(key) ?? []
			group.push({ args, value, rows: value.page })
			groups.set(key, group)
		}
		const id = change.kind === 'insert' ? change.row[descriptor.id] : change.id
		const matches = (row: Row) => compareValues(row[descriptor.id], id) === 0
		for (const group of groups.values()) {
			const source = group.flatMap((entry) =>
				entry.rows.filter(matches).map((row) => ({ entry, row })),
			)[0]
			let candidate: Row | undefined
			let placed = false
			if (change.kind === 'insert') {
				if (!source) candidate = change.row
			} else if (change.kind === 'patch') {
				for (const entry of group) {
					const fields = new Set(descriptor.fields(entry.args))
					entry.rows = entry.rows.flatMap((row) => {
						if (!matches(row)) return [row]
						const next = { ...row }
						for (const field of descriptor.writable) {
							// A patch cannot turn a hidden/absent output field into knowledge or expose an ID change.
							if (
								!Object.is(field, descriptor.id) &&
								fields.has(field) &&
								Object.hasOwn(row, field) &&
								Object.hasOwn(change.patch, field)
							)
								next[field] = change.patch[field]!
						}
						const { predicate } = descriptor.membership(entry.args)
						const accessible = new Set(Object.keys(row).filter((field) => fields.has(field)))
						if (evaluateFilter(predicate, next, accessible) === false) return []
						return [next]
					})
				}
				if (source) {
					const order = descriptor.order?.(source.entry.args)
					const next = source.entry.rows.find(matches)
					// Never infer rank from a field that was absent before the patch.
					if (
						next &&
						order?.length &&
						order.every(
							({ field }) =>
								Object.hasOwn(source.row, field) &&
								source.row[field] !== undefined &&
								descriptor.fields(source.entry.args).includes(field),
						) &&
						order.some(({ field }) => compareValues(source.row[field], next[field]) !== 0)
					)
						candidate = next
				}
			} else {
				for (const entry of group) entry.rows = entry.rows.filter((row) => !matches(row))
			}
			if (candidate) {
				let uncertainDestination = false
				const destinations = group.flatMap((entry) => {
					const fields = new Set(descriptor.fields(entry.args))
					const existing = entry.value.page.find(matches)
					// An existing copy owns its field knowledge, including fields absent through redaction.
					const localCandidate = existing ? entry.rows.find(matches) : candidate
					if (!localCandidate) return []
					// SAFETY: selecting only permitted DTO fields preserves their original values and never merges projections.
					const projected = Object.fromEntries(
						Object.entries(localCandidate).filter(([field]) => fields.has(field)),
					) as Row
					const { predicate, complete } = descriptor.membership(entry.args)
					const order = descriptor.order?.(entry.args)
					const interval = descriptor.interval?.(entry.args, entry.value)
					const accessible = new Set(Object.keys(projected))
					const membership = evaluateFilter(predicate, projected, accessible)
					if (membership === false) return []
					if (
						!accessible.has(descriptor.id) ||
						projected[descriptor.id] === undefined ||
						!order?.length ||
						!interval ||
						!order.every(({ field }) => accessible.has(field) && projected[field] !== undefined)
					) {
						uncertainDestination = true
						return []
					}
					const key = order.map(({ field }) => projected[field]!)
					if (
						(interval.lower &&
							(interval.lower.length !== order.length ||
								compareKeys(key, interval.lower, order) <= 0)) ||
						(interval.upper &&
							(interval.upper.length !== order.length ||
								compareKeys(key, interval.upper, order) > 0))
					)
						return []
					if (
						!complete ||
						membership !== true ||
						!entry.rows.every((row) =>
							order.every(
								({ field }) =>
									fields.has(field) && Object.hasOwn(row, field) && row[field] !== undefined,
							),
						)
					) {
						uncertainDestination = true
						return []
					}
					return [{ entry, projected, order }]
				})
				// Overlapping parent/split subscriptions are not evidence of a unique destination.
				if (!uncertainDestination && destinations.length === 1) {
					placed = true
					const { entry, projected, order } = destinations[0]
					for (const page of group) page.rows = page.rows.filter((row) => !matches(row))
					const index = entry.rows.findIndex(
						(row) =>
							compareKeys(
								order.map(({ field }) => projected[field]!),
								order.map(({ field }) => row[field]!),
								order,
							) < 0,
					)
					entry.rows = [
						...entry.rows.slice(0, index < 0 ? entry.rows.length : index),
						projected,
						...(index < 0 ? [] : entry.rows.slice(index)),
					]
				}
			}
			for (const entry of group) {
				const seen = new Set<string>()
				const rows = entry.rows.filter((row) => {
					if (!placed && (change.kind === 'insert' || !matches(row))) return true
					const key = JSON.stringify(convexToJson(row[descriptor.id] ?? null))
					if (seen.has(key)) return false
					seen.add(key)
					return true
				})
				if (
					rows.length === entry.value.page.length &&
					rows.every((row, i) => row === entry.value.page[i])
				)
					continue
				store.setQuery(reference, entry.args, { ...entry.value, page: rows })
			}
		}
	}
	return {
		patch: (store, id, patch) => apply(store, { kind: 'patch', id, patch }),
		insert: (store, row) => apply(store, { kind: 'insert', row }),
		delete: (store, id) => apply(store, { kind: 'delete', id }),
	}
}
function compareKeys(
	left: readonly Value[],
	right: readonly Value[],
	order: OptimisticOrder<string>,
): number {
	for (let index = 0; index < order.length; index++) {
		const compared = compareValues(left[index], right[index])
		if (compared) return order[index].direction === 'asc' ? compared : -compared
	}
	return 0
}
