// Import-only workload: the existing 87-table fixture, 30 contract pairs and
// 20 Effect registries. No handlers run and no registry identities are forced.
import { z } from 'zod'
import { defineDomainContract } from '../../src/contracts'
import { createEffectFoundation } from '../../src/effect'
import { defineTables, register } from './relations-fixture'

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
			get: query({ input: z.string(), result: z.string(), handler: (input) => input }),
		}),
	}),
)
export const timings = {
	zodTables: declared - start,
	defineRelations: registered - declared,
	contracts: contracted - registered,
	registries: performance.now() - contracted,
}
