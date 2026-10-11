/** Internal managed-read contracts for the relational executor. No root/package export. */
import type {
	GenericDataModel,
	GenericDatabaseReader,
	GenericDocument,
	GenericTableInfo,
	QueryInitializer,
} from 'convex/server'
import { getDocumentSize, type GenericId } from 'convex/values'
import type { Rules } from '../tenancy'

export const MAX_DOCUMENT_BYTES = 1024 * 1024

/** Additive context supplied to existing read/insert/modify rules on BOTH paths.
 * Reads through db are authorized and bounded. collect, native paginate/filter,
 * search, and system reads fail closed; use get, take/first/unique, or iteration.
 * Trusted server callbacks can close
 * over other readers; arbitrary captured JavaScript cannot be sandboxed here.
 */
export interface SecurityPolicyContext<DM extends GenericDataModel> {
	readonly db: GenericDatabaseReader<DM>
}

export interface ManagedScope {
	readonly mode: 'authenticated' | 'system' | 'trusted'
	readonly principal: string | null
	readonly organization: string | null
	readonly tenant: string | null
	readonly role: string | null
}

export interface ManagedBudgets {
	readOperations: number
	indexRanges: number
	rawCandidates: number
	documentBytes: number
	fanout: number
	depth: number
	memoEntries: number
}

/** Finite starting ceilings; U5/U6 adversarial workload evidence must tune them.
 * Document payload accounting is NOT Convex storage/index/prefetch I/O accounting.
 */
const defaultBudgets: Readonly<ManagedBudgets> = Object.freeze({
	readOperations: 4096,
	indexRanges: 1024,
	rawCandidates: 8192,
	documentBytes: 16 * MAX_DOCUMENT_BYTES,
	fanout: 1024,
	depth: 8,
	memoEntries: 4096,
})

export class ManagedReadError extends Error {
	constructor(
		readonly code:
			| 'UNMANAGED_QUERY_CONTEXT'
			| 'MANAGED_READ_BUDGET'
			| 'POLICY_RECURSION'
			| 'UNSUPPORTED_MANAGED_READ',
	) {
		super(code)
		this.name = 'ManagedReadError'
	}
}

interface Authority<DM extends GenericDataModel> {
	scope: ManagedScope
	rules: Rules<SecurityPolicyContext<DM>, DM>
	defaultPolicy: 'allow' | 'deny'
}
interface Capability<DM extends GenericDataModel> extends Authority<DM> {
	reader: GenericDatabaseReader<DM>
}
// Type erasure stays inside the private identity map; registration retains native DM.
const capabilities = new WeakMap<object, Capability<any>>()

/** Unique closure-only ordinary facade: helper implementation fields never leak.
 * Ordinary operations preserve their native/helper behavior and receive no new
 * engine ceilings. Register only from query constructors, never mutations/actions.
 */
export function registerQueryReader<DM extends GenericDataModel>(
	raw: GenericDatabaseReader<DM>,
	ordinary: GenericDatabaseReader<DM>,
	authority: Authority<DM>,
): GenericDatabaseReader<DM> {
	// SAFETY: all base-reader methods are bound forwards; the new identity hides helper fields.
	const facade: GenericDatabaseReader<DM> = Object.freeze({
		get: ordinary.get.bind(ordinary),
		query: <Table extends Parameters<typeof ordinary.query>[0]>(table: Table) =>
			ordinaryQuery(ordinary.query(table)),
		normalizeId: ordinary.normalizeId.bind(ordinary),
		system: Object.freeze({
			get: ordinary.system.get.bind(ordinary.system),
			query: <Table extends Parameters<typeof ordinary.system.query>[0]>(table: Table) =>
				ordinaryQuery(ordinary.system.query(table)),
			normalizeId: ordinary.system.normalizeId.bind(ordinary.system),
		}),
	})
	// SAFETY: capabilities are retrieved using the same facade with its native DM.
	capabilities.set(facade, { reader: raw, ...snapshot(authority) })
	return facade
}

export interface ManagedCounters {
	readonly readOperations: number
	readonly indexRanges: number
	readonly rawCandidates: number
	readonly documentBytesObserved: number
	readonly documentBytesReserved: number
	readonly fanout: number
	readonly memoEntries: number
}
export interface LeafReservation {
	/** Settle/refund exactly once, including missing/error results (null). */
	settle(document: GenericDocument | null): void
}
export interface ManagedReadRequest<DM extends GenericDataModel> {
	readonly db: GenericDatabaseReader<DM>
	readonly scope: ManagedScope & { readonly policyVersion: string }
	readonly budgets: Readonly<ManagedBudgets>
	readonly counters: ManagedCounters
	/** Future native leaf adapter reserves BEFORE every actual next/get, not an outer stream. */
	reserveLeaf(): LeafReservation
	openRange(): void
	expand(depth: number, count?: number): void
	/** Raw candidate visibility for the private executor; every leaf is metered.
	 * Its iterator reserves each next internally; do not add an outer reservation.
	 * Eligibility/authorization must complete before its key is eligible to advance.
	 */
	leafQuery(table: string): QueryInitializer<any>
	authorize(table: string, document: GenericDocument): Promise<boolean>
}

export interface ManagedSecurityConfig<DM extends GenericDataModel> {
	/** Entire registry: parent/junction/target/policy dependencies share one request. */
	tables: readonly string[]
	policyVersion: string
	budgets?: Partial<ManagedBudgets>
	/** Central server trust assertion. Never inspect third-party wrapper fields.
	 * The adapter must attest a QUERY transaction reader and the exact effective
	 * composed policy and immutable scope. It assumes responsibility for that claim.
	 */
	trustedAdapter?: (
		ctx: ManagedQueryContext<DM>,
	) => (Authority<DM> & { reader: GenericDatabaseReader<DM> }) | null
}

/** Native writer/action contexts are not accepted by the engine contract. */
export type ManagedQueryContext<DM extends GenericDataModel> = {
	db: GenericDatabaseReader<DM> & { insert?: never; patch?: never; replace?: never; delete?: never }
}

/** Central construction, then one shared request per engine invocation.
 * Requests may lower, never raise ceilings. Unknown/native contexts fail closed.
 */
export function createManagedSecurity<DM extends GenericDataModel = GenericDataModel>(
	config: ManagedSecurityConfig<DM>,
) {
	if (
		!config.policyVersion ||
		!config.tables.length ||
		new Set(config.tables).size !== config.tables.length ||
		config.tables.some((table) => !table || table.startsWith('_'))
	)
		throw new Error('Invalid managed security configuration')
	const tables = new Set(config.tables)
	// Central values may exceed starting defaults; these are application-owned ceilings.
	limits(config.budgets)
	const central = Object.freeze({ ...defaultBudgets, ...config.budgets })
	const policyVersion = config.policyVersion
	const trustedAdapter = config.trustedAdapter
	return <Ctx extends ManagedQueryContext<DM>>(
		ctx: Ctx,
		lower?: Partial<ManagedBudgets>,
	): ManagedReadRequest<DM> => {
		// SAFETY: identity is registered privately by the query constructor for this DM.
		const registered = capabilities.get(ctx.db) as Capability<DM> | undefined
		const adapted = registered ? undefined : trustedAdapter?.(ctx)
		if (!registered && !adapted) throw new ManagedReadError('UNMANAGED_QUERY_CONTEXT')
		const cap = registered ?? { ...adapted!, ...snapshot(adapted!) }
		return request(cap, tables, limits(lower, central), policyVersion)
	}
}

/** Ordinary rule invocations share a policy-only meter. Ordinary db reads stay
 * unmetered by engine ceilings; supplied rule dependencies never bypass policy.
 * Mutation insert/modify receive the same supplied contract as read callbacks.
 */
export function suppliedPolicyRules<DM extends GenericDataModel>(
	raw: GenericDatabaseReader<DM>,
	rules: Rules<SecurityPolicyContext<DM>, DM>,
	defaultPolicy: 'allow' | 'deny',
): Rules<SecurityPolicyContext<DM>, DM> {
	const cap = {
		reader: raw,
		...snapshot({
			rules,
			defaultPolicy,
			scope: { mode: 'trusted', principal: null, organization: null, tenant: null, role: null },
		}),
	}
	// Mutations can change dependencies between callbacks; never memoize ordinary
	// policy reads across writes. The shared policy meter still bounds all calls.
	const session = request(cap, null, defaultBudgets, 'ordinary-policy', false)
	const result: Rules<SecurityPolicyContext<DM>, DM> = {}
	for (const table of Object.keys(rules)) {
		const operations = rules[table]
		const wrapped: NonNullable<typeof operations> = {}
		if (operations?.read) wrapped.read = (_ctx, doc) => session.authorize(table, doc)
		if (operations?.insert)
			wrapped.insert = (_ctx, doc) => operations.insert!({ db: session.db }, doc)
		if (operations?.modify)
			wrapped.modify = (_ctx, doc) => operations.modify!({ db: session.db }, doc)
		// SAFETY: the keys originated from this same Rules map.
		result[table as keyof typeof result] = wrapped
	}
	return result
}

/** Forward only native query methods, never the RLS helper's unfiltered fields.
 * Ordinary consumption retains its existing policy and has no engine ceilings.
 */
function ordinaryQuery<T extends GenericTableInfo>(
	source: QueryInitializer<T>,
): QueryInitializer<T> {
	// SAFETY: native fluent methods retain the same table metadata; ordered results
	// only expose methods the native/helper source itself can successfully invoke.
	return Object.freeze({
		fullTableScan: () => ordinaryQuery(source.fullTableScan() as QueryInitializer<T>),
		withIndex: (...args: Parameters<typeof source.withIndex>) =>
			ordinaryQuery(source.withIndex(...args) as QueryInitializer<T>),
		withSearchIndex: (...args: Parameters<typeof source.withSearchIndex>) =>
			ordinaryQuery(source.withSearchIndex(...args) as QueryInitializer<T>),
		filter: (...args: Parameters<typeof source.filter>) =>
			ordinaryQuery(source.filter(...args) as QueryInitializer<T>),
		order: (...args: Parameters<typeof source.order>) =>
			ordinaryQuery(source.order(...args) as QueryInitializer<T>),
		paginate: source.paginate.bind(source),
		collect: source.collect.bind(source),
		take: source.take.bind(source),
		first: source.first.bind(source),
		unique: source.unique.bind(source),
		[Symbol.asyncIterator]: () => {
			const iterator = source[Symbol.asyncIterator]()
			const facade: typeof iterator = {
				next: iterator.next.bind(iterator),
			}
			if (iterator.return) facade.return = iterator.return.bind(iterator)
			if (iterator.throw) facade.throw = iterator.throw.bind(iterator)
			return Object.freeze(facade)
		},
	}) as QueryInitializer<T>
}

function limits(
	overrides: Partial<ManagedBudgets> = {},
	central = defaultBudgets,
): Readonly<ManagedBudgets> {
	for (const [key, value] of Object.entries(overrides)) {
		if (!Object.hasOwn(defaultBudgets, key) || !Number.isSafeInteger(value) || value <= 0)
			throw new Error('Invalid managed read budgets')
	}
	return Object.freeze({
		readOperations: Math.min(
			central.readOperations,
			overrides.readOperations ?? central.readOperations,
		),
		indexRanges: Math.min(central.indexRanges, overrides.indexRanges ?? central.indexRanges),
		rawCandidates: Math.min(
			central.rawCandidates,
			overrides.rawCandidates ?? central.rawCandidates,
		),
		documentBytes: Math.min(
			central.documentBytes,
			overrides.documentBytes ?? central.documentBytes,
		),
		fanout: Math.min(central.fanout, overrides.fanout ?? central.fanout),
		depth: Math.min(central.depth, overrides.depth ?? central.depth),
		memoEntries: Math.min(central.memoEntries, overrides.memoEntries ?? central.memoEntries),
	})
}

function snapshot<DM extends GenericDataModel>(authority: Authority<DM>): Authority<DM> {
	const rules = Object.fromEntries(
		Object.entries(authority.rules).map(([table, rules]) => [table, Object.freeze({ ...rules })]),
	)
	return Object.freeze({
		scope: Object.freeze({ ...authority.scope }),
		// SAFETY: only the table keys and operation callbacks of Rules were copied.
		rules: Object.freeze(rules) as Rules<SecurityPolicyContext<DM>, DM>,
		defaultPolicy: authority.defaultPolicy,
	})
}

function request<DM extends GenericDataModel>(
	cap: Capability<DM>,
	tables: ReadonlySet<string> | null,
	budgets: Readonly<ManagedBudgets>,
	policyVersion: string,
	memoize = true,
): ManagedReadRequest<DM> {
	const counts = {
		readOperations: 0,
		indexRanges: 0,
		rawCandidates: 0,
		documentBytesObserved: 0,
		documentBytesReserved: 0,
		fanout: 0,
		memoEntries: 0,
	}
	const view: ManagedCounters = Object.freeze({
		get readOperations() {
			return counts.readOperations
		},
		get indexRanges() {
			return counts.indexRanges
		},
		get rawCandidates() {
			return counts.rawCandidates
		},
		get documentBytesObserved() {
			return counts.documentBytesObserved
		},
		get documentBytesReserved() {
			return counts.documentBytesReserved
		},
		get fanout() {
			return counts.fanout
		},
		get memoEntries() {
			return counts.memoEntries
		},
	})
	const memo = new Map<string, GenericDocument | null>()
	let pendingMemo = 0
	let pendingCandidates = 0
	const fail = (): never => {
		throw new ManagedReadError('MANAGED_READ_BUDGET')
	}
	const assertTable = (table: string) => {
		if (table.startsWith('_') || (tables && !tables.has(table)))
			throw new ManagedReadError('UNSUPPORTED_MANAGED_READ')
	}
	const openRange = () => {
		if (counts.indexRanges >= budgets.indexRanges) fail()
		counts.indexRanges++
	}
	const reserveLeaf = (): LeafReservation => {
		if (
			counts.readOperations >= budgets.readOperations ||
			counts.rawCandidates + pendingCandidates >= budgets.rawCandidates ||
			counts.documentBytesObserved + counts.documentBytesReserved + MAX_DOCUMENT_BYTES >
				budgets.documentBytes
		)
			fail()
		counts.readOperations++
		pendingCandidates++
		counts.documentBytesReserved += MAX_DOCUMENT_BYTES
		let settled = false
		return {
			settle(document) {
				if (settled) throw new Error('Leaf reservation already settled')
				settled = true
				pendingCandidates--
				counts.documentBytesReserved -= MAX_DOCUMENT_BYTES
				if (document) {
					counts.rawCandidates++
					const size = getDocumentSize(document)
					counts.documentBytesObserved += size
					if (size > MAX_DOCUMENT_BYTES) fail()
				}
			},
		}
	}
	const keyOf = (table: string, id: string) => JSON.stringify([table, id])
	const checkCycle = (key: string, ancestors: readonly string[]) => {
		if (ancestors.includes(key)) throw new ManagedReadError('POLICY_RECURSION')
		if (ancestors.length >= budgets.depth) fail()
	}
	async function authorize(
		table: string,
		doc: GenericDocument,
		ancestors: readonly string[] = [],
	): Promise<boolean> {
		assertTable(table)
		// SAFETY: native documents carry a string system ID; normalizeId additionally verifies the declared table.
		const id = doc._id as GenericId<string>
		if (!cap.reader.normalizeId(table, id)) throw new ManagedReadError('UNSUPPORTED_MANAGED_READ')
		const key = keyOf(table, id)
		checkCycle(key, ancestors)
		const rule = cap.rules[table]?.read
		return rule
			? rule(Object.freeze({ db: reader([...ancestors, key]) }), doc)
			: cap.defaultPolicy === 'allow'
	}
	async function get(
		table: string,
		id: string,
		ancestors: readonly string[],
	): Promise<GenericDocument | null> {
		assertTable(table)
		const key = keyOf(table, id)
		checkCycle(key, ancestors) // BEFORE consulting memo: active policy cannot await itself.
		if (memo.has(key)) return memo.get(key)!
		if (memoize && counts.memoEntries >= budgets.memoEntries) fail()
		// Completed results only: independent concurrent branches cannot deadlock
		// through mutually pending memo promises. Concurrent duplicates may fetch twice.
		if (memoize) {
			pendingMemo++
			counts.memoEntries = memo.size + pendingMemo
		}
		try {
			openRange()
			const reservation = reserveLeaf()
			let doc: GenericDocument | null
			try {
				// SAFETY: IDs come from native readers or caller-branded IDs, with explicit table identity.
				doc = await cap.reader.get(table, id as GenericId<string>)
			} catch (error) {
				reservation.settle(null)
				throw error
			}
			reservation.settle(doc)
			const result = doc && (await authorize(table, doc, ancestors)) ? doc : null
			if (memoize) memo.set(key, result)
			return result
		} finally {
			if (memoize) {
				pendingMemo--
				counts.memoEntries = memo.size + pendingMemo
			}
		}
	}

	function query(
		table: string,
		source: QueryInitializer<any>,
		ancestors: readonly string[],
		authorized: boolean,
	): QueryInitializer<any> {
		function unsupported(): never {
			throw new ManagedReadError('UNSUPPORTED_MANAGED_READ')
		}
		async function* iterate() {
			openRange()
			let iterator: AsyncIterator<GenericDocument> | undefined
			try {
				while (true) {
					const reservation = reserveLeaf()
					let next: IteratorResult<GenericDocument>
					try {
						// Native iterator construction starts the query. Reserve before
						// both initialization and next; every later next reserves anew.
						iterator ??= source[Symbol.asyncIterator]()
						next = await iterator.next()
					} catch (error) {
						reservation.settle(null)
						throw error
					}
					reservation.settle(next.done ? null : next.value)
					if (next.done) return
					if (!authorized || (await authorize(table, next.value, ancestors))) yield next.value
				}
			} finally {
				await iterator?.return?.()
			}
		}
		async function take(n: number) {
			if (!Number.isSafeInteger(n) || n < 0 || n > budgets.rawCandidates)
				throw new ManagedReadError('MANAGED_READ_BUDGET')
			const docs: GenericDocument[] = []
			if (n === 0) return docs
			for await (const doc of iterate()) {
				docs.push(doc)
				if (docs.length === n) break
			}
			return docs
		}
		// SAFETY: forwarding preserves native document/index types; only consumers are replaced.
		return Object.freeze({
			fullTableScan: () =>
				query(table, source.fullTableScan() as QueryInitializer<any>, ancestors, authorized),
			withIndex: (...args: Parameters<typeof source.withIndex>) =>
				query(table, source.withIndex(...args) as QueryInitializer<any>, ancestors, authorized),
			order: (...args: Parameters<typeof source.order>) =>
				query(table, source.order(...args) as QueryInitializer<any>, ancestors, authorized),
			// Native filters/search/pagination may scan/prefetch hidden rows. They
			// cannot prove per-leaf reservation via public APIs; reject on managed readers.
			filter: unsupported,
			withSearchIndex: unsupported,
			paginate: unsupported,
			collect: unsupported,
			take,
			first: async () => (await take(1))[0] ?? null,
			unique: async () => {
				const docs = await take(2)
				if (docs.length > 1) throw new Error('Query is not unique')
				return docs[0] ?? null
			},
			[Symbol.asyncIterator]: iterate,
		}) as QueryInitializer<any>
	}
	function reader(ancestors: readonly string[]): GenericDatabaseReader<any> {
		const blocked = () => {
			throw new ManagedReadError('UNSUPPORTED_MANAGED_READ')
		}
		// SAFETY: normalizeId retains the requested table brand; query forwarding retains native table metadata.
		return Object.freeze({
			get: async (arg0: string, arg1?: string) => {
				if (arg1 !== undefined) return get(arg0, arg1, ancestors)
				// Resolve only from the explicit registry (or known policy tables for
				// ordinary policy callbacks). Never raw-get an unrecognized ID.
				const table = [...(tables ?? new Set(Object.keys(cap.rules)))].find((name) =>
					cap.reader.normalizeId(name, arg0),
				)
				return table ? get(table, arg0, ancestors) : null
			},
			query: (table: string) => {
				assertTable(table)
				return query(table, cap.reader.query(table), ancestors, true)
			},
			normalizeId: (table: string, id: string) => {
				assertTable(table)
				return cap.reader.normalizeId(table, id)
			},
			system: Object.freeze({ get: blocked, query: blocked, normalizeId: blocked }),
		}) as GenericDatabaseReader<any>
	}
	return Object.freeze({
		db: reader([]),
		scope: Object.freeze({ ...cap.scope, policyVersion }),
		budgets,
		counters: view,
		reserveLeaf,
		openRange,
		expand(depth: number, count = 1) {
			if (
				!Number.isSafeInteger(depth) ||
				depth < 0 ||
				depth > budgets.depth ||
				!Number.isSafeInteger(count) ||
				count < 0 ||
				counts.fanout + count > budgets.fanout
			)
				fail()
			counts.fanout += count
		},
		leafQuery: (table: string) => {
			assertTable(table)
			return query(table, cap.reader.query(table), [], false)
		},
		authorize: (table: string, doc: GenericDocument) => authorize(table, doc),
	})
}
