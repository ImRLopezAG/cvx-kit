// Import-only workload: the existing 87-table fixture, 30 contract pairs and
// 20 Effect registries. No handlers run and no registry identities are forced.
// The v1 (Zod) twin is this file at commit 8d979a5.
import { k } from '../../src/k'
import { defineDomainContract } from '../../src/contracts'
import { createEffectFoundation } from '../../src/effect'
import { defineTables, register } from '../../test/fixture-querying/bench-relations'

declare const __CVX_BENCH_LAZY_CONTRACTS__: boolean

const start = performance.now()
export const tables = defineTables()
const declared = performance.now()
export const relations = register(tables)
const registered = performance.now()
export const contracts = Array.from({ length: 30 }, () => {
	const build = () => ({
		queries: {
			list: {
				input: tables.tables.tasks.paginationOpts({ status: true, priority: true }),
				result: relations.tables.tasks.pageDto({}),
			},
		},
	})
	return defineDomainContract(__CVX_BENCH_LAZY_CONTRACTS__ ? build : build())
})
const contracted = performance.now()
const foundation = createEffectFoundation({
	writeAudit: () => {},
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
	},
})
export const registries = Array.from({ length: 20 }, () =>
	foundation.Query({
		context: () => ({}),
		operations: ({ query }) => ({
			get: query({ input: k.string(), result: k.string(), handler: (input) => input }),
		}),
	}),
)
export const timings = {
	tables: declared - start,
	defineRelations: registered - declared,
	contracts: contracted - registered,
	registries: performance.now() - contracted,
}
