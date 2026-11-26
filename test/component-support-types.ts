import type { DataModelFromSchemaDefinition, DocumentByName, GenericQueryCtx } from 'convex/server'
import { defineSchema } from 'convex/server'
import { Effect } from 'effect'
import { defineDomainContract } from '../src/contracts'
import { createEffectFoundation } from '../src/effect'
import { k } from '../src/k'
import { kTable } from '../src/table'

const intents = kTable('intents', { key: k.string() })
const schema = defineSchema({ intents: intents.table })
type DataModel = DataModelFromSchemaDefinition<typeof schema>
type Row = DocumentByName<DataModel, 'intents'>
const { Query } = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
	},
	writeAudit: () => undefined,
})
const args = k.object({ id: intents.schema.shape._id })
const contract = defineDomainContract({
	queries: {
		read: { input: args, result: intents.schema.nullable() },
		effectRead: { input: args, result: intents.schema.nullable() },
		required: { input: args, result: intents.schema.extend({ createdAt: k.number() }).nullable() },
	},
})
Query({
	contract,
	context: (ctx: GenericQueryCtx<DataModel>) => ctx,
	operations: ({ query }) => ({
		// Native Id<'intents'> and optional injected timestamps fit the derived contract.
		read: query.read({ handler: ({ id }, ctx): Promise<Row | null> => ctx.db.get(id) }),
		effectRead: query.effectRead({
			handler: ({ id }, ctx) => Effect.promise(() => ctx.db.get(id)),
		}),
		// @ts-expect-error A trigger does not statically narrow optional storage fields to required numbers.
		required: query.required({ handler: ({ id }, ctx) => ctx.db.get(id) }),
	}),
})
const required = intents.schema.extend({ createdAt: k.number() })
Query({
	contract: defineDomainContract({
		queries: { read: { input: args, result: required.nullable() } },
	}),
	context: (ctx: GenericQueryCtx<DataModel>) => ctx,
	operations: ({ query }) => ({
		read: query.handler(async ({ id }, ctx) => {
			const row = await ctx.db.get(id)
			// Explicit validation handles old rows and narrows the result without casts.
			return row === null ? null : required.parse(row)
		}),
	}),
})
