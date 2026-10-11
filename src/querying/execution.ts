import { QueryStream, stream, type IndexBounds, type IndexKey } from 'convex-helpers/server/stream'
import type {
	GenericDatabaseReader,
	GenericDataModel,
	GenericDocument,
	QueryInitializer,
	SchemaDefinition,
	GenericSchema,
	PaginationResult,
	TableDefinition,
	IndexRangeBuilder,
} from 'convex/server'
import type { Value } from 'convex/values'
import type { createPlanner } from './planner'
import { MAX_DOCUMENT_BYTES, ManagedReadError, type ManagedReadRequest } from './security'
import { CursorError, type CursorBinding, type createCursorCodec } from './cursors'
import type { NativePagination } from './filters'

type Entry = [Record<string, Value> | null, IndexKey, number]
type Plan = ReturnType<ReturnType<typeof createPlanner>['plan']>
type Codec = ReturnType<typeof createCursorCodec>
type Request = Omit<ManagedReadRequest<GenericDataModel>, 'db'>
type ExecutionSchema = SchemaDefinition<
	Record<string, TableDefinition<any, Record<string, string[]>>>,
	boolean
>

export async function executeScalar(
	schema: SchemaDefinition<GenericSchema, boolean>,
	request: Request,
	table: string,
	plan: Plan,
	planner: ReturnType<typeof createPlanner>,
	codec: Codec,
	binding: CursorBinding,
) {
	// Authenticate BOTH navigation slots before constructing or consuming native queries.
	const args = {
		...plan.args,
		cursor: plan.args.cursor === null ? null : codec.open(plan.args.cursor, binding),
		endCursor:
			plan.args.endCursor == null ? plan.args.endCursor : codec.open(plan.args.endCursor, binding),
	}
	const leaves = leafReader(request, planner)
	try {
		// SAFETY: runtime ownership/index validation precedes this dynamic table
		// adapter. Public generics retain the original application's schema.
		const base = stream(leaves.db, schema as ExecutionSchema).query(table)
		const selected = plan.index
			? base.withIndex(plan.index.name, (q) => {
					// SAFETY: every equality is a validated consecutive native prefix.
					let range = q as IndexRangeBuilder<any, string[], number>
					for (const { field, value } of plan.prefix) {
						// SAFETY: native eq returns the next builder; runtime prefix length
						// is validated even though this dynamic adapter erases tuple lengths.
						range = range.eq(field, value) as IndexRangeBuilder<any, string[], number>
					}
					return range
				})
			: base
		const source = selected.order(plan.args.order ?? 'asc')
		const result = await new EligibleStream(source, request, table, plan, planner, {
			completed: [],
			stopped: false,
		}).paginate(args)
		const protectedResult = {
			...result,
			continueCursor: codec.seal(result.continueCursor, binding),
		}
		if (result.splitCursor != null)
			protectedResult.splitCursor = codec.seal(result.splitCursor, binding)
		return protectedResult
	} catch (error) {
		if (error instanceof ManagedReadError || error instanceof CursorError) throw error
		// Native errors may include a decoded key; never forward their message.
		throw new Error('Query execution failed')
	} finally {
		await leaves.close()
	}
}

/** Retain the actual metered leaf, since the helper's public key iterator does
 * not forward return(). This private reader only constructs raw metered queries.
 */
function leafReader(request: Request, planner: ReturnType<typeof createPlanner>) {
	const active = new Set<AsyncIterator<GenericDocument>>()
	function wrap<Source extends AsyncIterable<GenericDocument>>(
		table: string,
		source: Source,
	): Source {
		// SAFETY: the empty proxy shell is private; supported methods forward to the real native source below.
		return new Proxy({} as Source, {
			get(_target, key) {
				const target = source
				if (key === 'withIndex' && 'withIndex' in target)
					return (...args: Parameters<QueryInitializer<any>['withIndex']>) => {
						// SAFETY: the private facade forwards an existing native index constructor only.
						const withIndex = target.withIndex as QueryInitializer<any>['withIndex']
						return wrap(table, withIndex.apply(target, args))
					}
				if (key === 'order' && 'order' in target)
					return (...args: Parameters<QueryInitializer<any>['order']>) => {
						// SAFETY: the private facade forwards the existing native order method only.
						const order = target.order as QueryInitializer<any>['order']
						return wrap(table, order.apply(target, args))
					}
				if (key === Symbol.asyncIterator)
					return () => {
						const iterator = target[Symbol.asyncIterator]()
						active.add(iterator)
						return {
							next: () => {
								planner.beforeLeaf(table)
								return iterator.next()
							},
						}
					}
				throw new Error('Unsupported private query operation')
			},
		})
	}

	// SAFETY: stream() uses only query to construct the indexed stream. The
	// request's authorized reader handles policy gets separately; never publish this facade.
	const db = {
		query: (table: string) => {
			planner.beforeLeaf(table)
			return wrap(table, request.leafQuery(table))
		},
	} as GenericDatabaseReader<any>
	return {
		db,
		async close() {
			let failed = false
			for (const iterator of active) {
				try {
					await iterator.return?.()
				} catch {
					failed = true
				}
			}
			active.clear()
			if (failed) throw new Error('Query execution failed')
		},
	}
}

function canFetch(request: Request): boolean {
	const c = request.counters,
		b = request.budgets
	return (
		c.readOperations < b.readOperations &&
		c.rawCandidates < b.rawCandidates &&
		c.documentBytesObserved + c.documentBytesReserved + MAX_DOCUMENT_BYTES <= b.documentBytes
	)
}

/** Encoder-only use of public native pagination; no private cursor wire format,
 * artificial bandwidth, lookahead, or database read.
 */
class CapturedKey extends QueryStream<object> {
	constructor(
		private readonly entry: Entry,
		private readonly source: QueryStream<Record<string, Value>>,
	) {
		super()
	}
	getOrder() {
		return this.source.getOrder()
	}
	getIndexFields() {
		return this.source.getIndexFields()
	}
	getEqualityIndexFilter() {
		return this.source.getEqualityIndexFilter()
	}
	narrow(bounds: IndexBounds) {
		if (
			bounds.lowerBound.length ||
			bounds.upperBound.length ||
			!bounds.lowerBoundInclusive ||
			!bounds.upperBoundInclusive
		)
			throw new Error('Invalid cursor encoder range')
		return this
	}
	async *iterWithKeys(): AsyncGenerator<[object, IndexKey, number], undefined> {
		yield [{}, this.entry[1], this.entry[2]]
	}
}

interface Progress {
	completed: Entry[]
	stopped: boolean
}
class EligibleStream extends QueryStream<Record<string, Value>> {
	constructor(
		private readonly source: QueryStream<Record<string, Value>>,
		private readonly request: Request,
		private readonly table: string,
		private readonly plan: Plan,
		private readonly planner: ReturnType<typeof createPlanner>,
		private readonly progress: Progress,
	) {
		super()
	}
	getOrder() {
		return this.source.getOrder()
	}
	getIndexFields() {
		return this.source.getIndexFields()
	}
	getEqualityIndexFilter() {
		return this.source.getEqualityIndexFilter()
	}
	narrow(bounds: IndexBounds): QueryStream<Record<string, Value>> {
		return new EligibleStream(
			this.source.narrow(bounds),
			this.request,
			this.table,
			this.plan,
			this.planner,
			this.progress,
		)
	}
	async *iterWithKeys(): AsyncGenerator<Entry, undefined> {
		// Always request actual root bandwidth, even without a native byte option.
		const iterator = this.source.iterWithKeys(true)[Symbol.asyncIterator]()
		try {
			while (true) {
				if (!canFetch(this.request)) {
					if (!this.progress.completed.length) throw new ManagedReadError('MANAGED_READ_BUDGET')
					this.progress.stopped = true
					return
				}
				let next: IteratorResult<Entry>
				const candidatesBefore = this.request.counters.rawCandidates
				try {
					next = await iterator.next()
				} catch (error) {
					// A reservation failure BEFORE the next root is safe to stop at
					// completed progress. Authorization errors below are never partialized.
					if (
						error instanceof ManagedReadError &&
						error.code === 'MANAGED_READ_BUDGET' &&
						this.progress.completed.length &&
						this.request.counters.rawCandidates === candidatesBefore
					) {
						this.progress.stopped = true
						return
					}
					throw error
				}
				if (next.done) return
				const [document, key, bytes] = next.value
				let output: Record<string, Value> | null = null
				if (document) {
					// SAFETY: metered native stream documents contain their system IDs.
					const permitted = await this.request.authorize(this.table, document as GenericDocument)
					// One live whole-registry guard covers the synchronous residual
					// and strict projection step AFTER the asynchronous policy finishes.
					// SAFETY: the registry DTO validates declared public native values only.
					output = this.planner.complete(
						this.table,
						document,
						permitted,
						this.plan.residual,
					) as Record<string, Value> | null
				}
				// Complete policy, residual, and required DTO before recording the key.
				const entry: Entry = [output, key, bytes]
				this.progress.completed.push(entry)
				if (!canFetch(this.request)) this.progress.stopped = true
				yield entry
			}
		} finally {
			await iterator.return?.()
		}
	}
	override async paginate(
		args: NativePagination,
	): Promise<PaginationResult<Record<string, Value>>> {
		const result = await super.paginate(args)
		if (!this.progress.stopped) return result
		const completed = this.progress.completed
		if (!completed.length) throw new ManagedReadError('MANAGED_READ_BUDGET')
		const encode = async (entry: Entry) =>
			(await new CapturedKey(entry, this.source).paginate({ numItems: 1, cursor: null }))
				.continueCursor
		return {
			...result,
			isDone: false,
			pageStatus: 'SplitRequired',
			continueCursor: await encode(completed.at(-1)!),
			splitCursor: await encode(completed[Math.floor((completed.length - 1) / 2)]),
		}
	}
}
