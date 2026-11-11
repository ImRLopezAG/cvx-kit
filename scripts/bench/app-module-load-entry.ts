// One Convex function module of the representative app: it imports the shared
// table boundaries, relations and auth builders, and registers every operation
// of one domain contract. Convex evaluates this graph on every request.
import {
	defineAppAuth,
	defineAppContract,
	defineAppRelations,
	defineAppTables,
} from './app-fixture'

/** `true`: consumers declare `get args()` / `get returns()` and lazy contract operations. */
declare const __CVX_BENCH_GETTERS__: boolean

const start = performance.now()
const tables = defineAppTables()
const declared = performance.now()
const relations = defineAppRelations(tables)
const related = performance.now()
const contract = defineAppContract(tables, relations, 'entity1', __CVX_BENCH_GETTERS__)
// Other domains' contracts are imported through shared modules but never read here.
export const otherContracts = [2, 3].map((index) =>
	defineAppContract(tables, relations, `entity${index}`, __CVX_BENCH_GETTERS__),
)
const auth = defineAppAuth()
const authorized = performance.now()

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Generated operation names.
const functions: Record<string, any> = {}
// SAFETY: erased builder types; the benchmark measures registration cost only.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-object-parameters, anti-slop/no-unknown-returns -- Generated operation names erase builder types.
const builders = auth as unknown as Record<string, (definition: object) => unknown>
for (const [kind, builder] of [
	['commands', builders.authMutation!],
	['queries', builders.authQuery!],
] as const) {
	const section = contract[kind]
	for (const key of Object.keys(section)) {
		functions[key] = builder(
			__CVX_BENCH_GETTERS__
				? {
						get args() {
							return section[key]!.input
						},
						get returns() {
							return section[key]!.result
						},
						handler: async () => null,
					}
				: { args: section[key]!.input, returns: section[key]!.result, handler: async () => null },
		)
	}
}
const registered = performance.now()

export const timings = {
	zodTables: declared - start,
	defineRelations: related - declared,
	contractsAndAuth: authorized - related,
	registration: registered - authorized,
}
export const functionCount = Object.keys(functions).length

/** What serving one call of `listPayments` needs beyond import: its validators. */
export function invoke() {
	const fn = functions.listPayments
	return fn.exportArgs().length + fn.exportReturns().length
}

/** Pushed metadata for every function; compared across sources by the harness. */
export function snapshot() {
	return Object.fromEntries(
		Object.entries(functions).map(([key, fn]) => [key, [fn.exportArgs(), fn.exportReturns()]]),
	)
}
