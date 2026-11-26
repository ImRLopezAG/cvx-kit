// One Convex function module of the v1 app: it declares the tables, builds the
// auth builders and registers the five operations of one domain. Convex
// evaluates this graph on every request.
import { defineAppAuth, defineAppTables, defineOperations } from './v1-fixture'
import { registerOperations, type AuthBuilders } from './register'

/** `true`: operations declare `get args()` / `get returns()`. */
declare const __CVX_BENCH_GETTERS__: boolean

const start = performance.now()
const tables = defineAppTables()
const declared = performance.now()
const auth = defineAppAuth()
const authorized = performance.now()
// SAFETY: both auth factories return builders accepting this definition; their precise generic types are erased here.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The shared registration helper serves v1 and v2 builders alike.
const builders = auth as unknown as AuthBuilders
export const functions = registerOperations(
	builders,
	defineOperations(tables),
	__CVX_BENCH_GETTERS__,
)
const registered = performance.now()

export const timings = {
	tables: declared - start,
	auth: authorized - declared,
	registration: registered - authorized,
}
