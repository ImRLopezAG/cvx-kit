import type { DataModelFromSchemaDefinition, DocumentByName, GenericQueryCtx } from 'convex/server'
import { defineSchema } from 'convex/server'
import { Effect } from 'effect'
import { z } from 'zod'
import { zodTable } from '../src/zod-table'
import { defineDomainContract } from '../src/contracts'
import { createEffectFoundation } from '../src/effect'

const intents = zodTable('intents', () => ({ key: z.string() }))
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
const args = z.object({ id: intents.schema.shape._id })
const contract = defineDomainContract({
	queries: {
		read: { input: args, result: intents.schema.nullable() },
		effectRead: { input: args, result: intents.schema.nullable() },
		required: { input: args, result: intents.schema.required({ createdAt: true }).nullable() },
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
const required = intents.schema.required({ createdAt: true })
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
