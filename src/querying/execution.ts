import {
	EmptyStream,
	QueryStream,
	stream,
	type IndexBounds,
	type IndexKey,
} from 'convex-helpers/server/stream'
import type {
	GenericDatabaseReader,
	GenericDataModel,
	GenericDocument,
	QueryInitializer,
	SchemaDefinition,
	GenericSchema,
	TableDefinition,
	IndexRangeBuilder,
} from 'convex/server'
import type { Value } from 'convex/values'
import type { createPlanner } from './planner'
import { MAX_DOCUMENT_BYTES, ManagedReadError, type ManagedReadRequest } from './security'
import { CursorError, type CursorBinding, type createCursorCodec } from './cursors'
import type { NativePagination, NativeRange, FilterScalar } from './filters'
import { RelationshipError } from './relationships'
import type { EnginePaginationResult, PageCompleteness } from '../zod-table'

type Entry = [Record<string, Value> | null, IndexKey, number]
type Plan = ReturnType<ReturnType<typeof createPlanner>['plan']>
type Codec = ReturnType<typeof createCursorCodec>
export type ExecutionRequest = ManagedReadRequest<GenericDataModel>
type Request = Omit<ExecutionRequest, 'db'>
type ExecutionSchema = SchemaDefinition<
	Record<string, TableDefinition<any, Record<string, string[]>>>,
	boolean
>

/** Private shared boundary: only the established fixed typed errors are public. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Thrown values enter this error boundary untrusted; the class checks below admit only the fixed public error contracts.
export function rethrowQueryError(error: unknown): never {
	if (
		error instanceof ManagedReadError ||
		error instanceof CursorError ||
		error instanceof RelationshipError
	)
		throw error
	// Native/policy errors may contain traversal values or structured private data.
	throw new Error('Query execution failed')
}

export async function executeQuery(
	schema: SchemaDefinition<GenericSchema, boolean>,
	request: Request,
	table: string,
	plan: Plan,
	planner: ReturnType<typeof createPlanner>,
	codec: Codec,
	binding: CursorBinding,
	complete?: (
		document: Record<string, Value>,
		permitted: boolean,
	) => Promise<Record<string, Value> | null>,
) {
	// Authenticate BOTH navigation slots before constructing or consuming native queries.
	const args = {
		...plan.args,
		cursor: plan.args.cursor === null ? null : codec.open(plan.args.cursor, binding),
		endCursor:
			plan.args.endCursor == null ? plan.args.endCursor : codec.open(plan.args.endCursor, binding),
	}
	return executeStream(schema, request, table, plan, planner, codec, binding, args, complete)
}

export async function executeStream(
	schema: SchemaDefinition<GenericSchema, boolean>,
	request: Request,
	table: string,
	plan: Plan,
	planner: ReturnType<typeof createPlanner>,
	codec: Codec,
	binding: CursorBinding,
	args: NativePagination,
	complete?: (
		document: Record<string, Value>,
		permitted: boolean,
	) => Promise<Record<string, Value> | null>,
	seal: (raw: string) => string = (raw) => codec.seal(raw, binding),
	transform?: (
		source: QueryStream<Record<string, Value>>,
		db: GenericDatabaseReader<any>,
	) => QueryStream<Record<string, Value>>,
	authorizationTable = table,
) {
	const leaves = leafReader(request, planner)
	const progress: Progress = { completed: [] }
	try {
		// SAFETY: runtime ownership/index validation precedes this dynamic table
		// adapter. Public generics retain the original application's schema.
		const base = stream(leaves.db, schema as ExecutionSchema).query(table)
		const selected = plan.index
			? base.withIndex(plan.index.name, (q) => nativeIndexRange(q, plan.prefix, plan.range))
			: base
		const ordered = selected.order(plan.args.order ?? 'asc')
		const source = transform ? transform(ordered, leaves.db) : ordered
		const result: EnginePaginationResult<Record<string, Value>> = plan.unsatisfiable
			? await new EmptyStream<Record<string, Value>>(
					source.getOrder(),
					source.getIndexFields(),
					source.getEqualityIndexFilter(),
				).paginate(args)
			: await new EligibleStream(
					source,
					request,
					authorizationTable,
					plan,
					planner,
					progress,
					complete,
				).paginate(args)
		const protectedResult = {
			...result,
			completeness: result.completeness ?? 'complete',
			continueCursor: seal(result.continueCursor),
		}
		if (result.splitCursor != null) protectedResult.splitCursor = seal(result.splitCursor)
		return protectedResult
	} catch (error) {
		rethrowQueryError(error)
	} finally {
		await leaves.close()
	}
}

/** Private adapter shared by root and relationship streams; the planner owns admission. */
export function nativeIndexRange(
	q: IndexRangeBuilder<any, string[], number>,
	prefix: readonly { field: string; value: FilterScalar }[],
	bounds: NativeRange | null,
): import('convex/server').IndexRange {
	let range = q
	for (const { field, value } of prefix) {
		// SAFETY: every equality advances the validated consecutive native prefix.
		range = range.eq(field, value) as IndexRangeBuilder<any, string[], number>
	}
	// SAFETY: an equality builder also admits upper bounds; lower methods retain that interface.
	let bounded = range as ReturnType<typeof range.gte>
	if (bounds?.lower) {
		const { field, lower } = bounds
		bounded = lower.inclusive ? range.gte(field, lower.value) : range.gt(field, lower.value)
	}
	if (bounds?.upper) {
		const { field, upper } = bounds
		return upper.inclusive ? bounded.lte(field, upper.value) : bounded.lt(field, upper.value)
	}
	return bounded
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

function fetchStopReason(request: Request): 'row-budget' | 'byte-budget' | undefined {
	const c = request.counters,
		b = request.budgets
	// Row checks precede byte reservation, matching the managed leaf admission order.
	if (c.readOperations >= b.readOperations || c.rawCandidates >= b.rawCandidates)
		return 'row-budget'
	if (c.documentBytesObserved + c.documentBytesReserved + MAX_DOCUMENT_BYTES > b.documentBytes)
		return 'byte-budget'
	return undefined
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
	stopReason?: PageCompleteness
}
class EligibleStream extends QueryStream<Record<string, Value>> {
	constructor(
		private readonly source: QueryStream<Record<string, Value>>,
		private readonly request: Request,
		private readonly table: string,
		private readonly plan: Plan,
		private readonly planner: ReturnType<typeof createPlanner>,
		private readonly progress: Progress,
		private readonly complete?: (
			document: Record<string, Value>,
			permitted: boolean,
		) => Promise<Record<string, Value> | null>,
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
			this.complete,
		)
	}
	async *iterWithKeys(): AsyncGenerator<Entry, undefined> {
		// Always request actual root bandwidth, even without a native byte option.
		const iterator = this.source.iterWithKeys(true)[Symbol.asyncIterator]()
		try {
			while (true) {
				const reason = fetchStopReason(this.request)
				if (reason) {
					if (!this.progress.completed.length) throw new ManagedReadError('MANAGED_READ_BUDGET')
					this.progress.stopReason = reason
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
						this.request.leafBudgetFailure(error) &&
						this.progress.completed.length &&
						this.request.counters.rawCandidates === candidatesBefore
					) {
						this.progress.stopReason = this.request.leafBudgetFailure(error)
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
					// SAFETY: the registry DTO validates declared public native values only.
					output = this.complete
						? await this.complete(document, permitted)
						: (this.planner.complete(this.table, document, permitted, this.plan.residual) as Record<
								string,
								Value
							> | null)
				}
				// Complete policy, residual, and required DTO before recording the key.
				const entry: Entry = [output, key, bytes]
				this.progress.completed.push(entry)
				yield entry
			}
		} finally {
			await iterator.return?.()
		}
	}
	override async paginate(
		args: NativePagination,
	): Promise<EnginePaginationResult<Record<string, Value>>> {
		const result = await super.paginate(args)
		const completed = this.progress.completed
		const encode = async (entry: Entry) =>
			(await new CapturedKey(entry, this.source).paginate({ numItems: 1, cursor: null }))
				.continueCursor
		const fulfilled = args.endCursor
			? !!completed.length && (await encode(completed.at(-1)!)) === args.endCursor
			: result.page.length >= args.numItems
		if (!this.progress.stopReason)
			return {
				...result,
				// A helper limit can coincide with the requested final row. That page
				// is fulfilled; preserve the native split/isDone/cursor metadata separately.
				completeness:
					result.pageStatus === 'SplitRequired' && !fulfilled ? 'native-limit' : 'complete',
			}
		if (!completed.length) throw new ManagedReadError('MANAGED_READ_BUDGET')
		const continuation = await encode(completed.at(-1)!)
		return {
			...result,
			completeness: fulfilled ? 'complete' : this.progress.stopReason,
			isDone: false,
			pageStatus: 'SplitRequired',
			continueCursor: continuation,
			splitCursor: await encode(completed[Math.floor((completed.length - 1) / 2)]),
		}
	}
}
