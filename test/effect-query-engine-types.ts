import { defineSchema, type DataModelFromSchemaDefinition } from 'convex/server'
import { Effect } from 'effect'
import { k } from '../src/k'
import { kTable } from '../src/table'
import { defineRelations } from '../src/relations'
import { createQueryEngine } from '../src/querying'
import type { ManagedQueryContext } from '../src/querying/security'
import { createEffectFoundation } from '../src/effect'
import { defineDomainContract } from '../src/modules/contracts/domain'

// A context that returns the engine handle from a function makes TypeScript measure the handle's
// variance, which resolves the filter types against unresolved validators. One table is enough.
const nodes = kTable('nodes', { name: k.string(), next: k.id('nodes') }, { publicFields: ['name'] })
const relations = defineRelations({ nodes }, (r) => ({
	nodes: { related: r.one.nodes({ from: r.nodes.next, to: r.nodes._id }) },
}))
const schema = defineSchema({ nodes: nodes.table })
const querying = createQueryEngine({ schema, relations })
type Host = ManagedQueryContext<DataModelFromSchemaDefinition<typeof schema>>
const foundation = createEffectFoundation({
	observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'F' }) },
	writeAudit: () => undefined,
})
const contract = defineDomainContract({
	queries: { read: { input: k.object({}), result: k.number() } },
})
const thunkQueries = foundation.Query({
	contract,
	context: (host: Host) => ({ ...host, querying: () => querying(host) }),
	operations: ({ query }) => ({
		read: query.handler((_input, context) =>
			Effect.gen(function* () {
				const handle = context.querying()
				const page = yield* Effect.promise(() =>
					handle.nodes.with({ related: true }).paginate({ numItems: 10, cursor: null }),
				)
				const name: string = page.page[0].name
				void name
				return page.page.length
			}),
		),
	}),
})
// A handle resolved by an Effect-produced context.
const handleQueries = foundation.Query({
	contract,
	context: (host: Host) => Effect.succeed({ querying: querying(host) }),
	operations: ({ query }) => ({
		read: query.handler((_input, context) =>
			Effect.gen(function* () {
				const page = yield* Effect.promise(() =>
					context.querying.nodes.paginate({ numItems: 10, cursor: null }),
				)
				return page.page.length
			}),
		),
	}),
})

// The engine may also be created inside the handler from the host context.
const localQueries = foundation.Query({
	contract,
	context: (host: Host) => host,
	operations: ({ query }) => ({
		read: query.handler((_input, context) =>
			Effect.gen(function* () {
				const handle = querying(context)
				const page = yield* Effect.promise(() =>
					handle.nodes.with({ related: true }).paginate({ numItems: 10, cursor: null }),
				)
				const name: string = page.page[0].name
				void name
				return page.page.length
			}),
		),
	}),
})
void [thunkQueries, handleQueries, localQueries]
