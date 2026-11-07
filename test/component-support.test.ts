import { convexTest } from 'convex-test'
import {
	defineSchema,
	mutationGeneric,
	internalMutationGeneric,
	queryGeneric,
	type DataModelFromSchemaDefinition,
	type GenericMutationCtx,
	type GenericQueryCtx,
	type MutationBuilder,
	type QueryBuilder,
	type ApiFromModules,
} from 'convex/server'
import { customMutation, NoOp } from 'convex-helpers/server/customFunctions'
import { zCustomMutation, zCustomQuery } from 'convex-helpers/server/zod4'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'
import { z } from 'zod'
import { zodTable } from '../src/zod-table'
import { createEffectFoundation, effectZodApiBuilder } from '../src/effect'
import { defineDomainContract } from '../src/contracts'
import { createTriggers, timestamps, noDelete, triggerContext } from '../src/triggers'

const intents = zodTable('intents', () => ({ key: z.string(), count: z.number() }))
const history = zodTable('history', (id) => ({ intentId: id('intents') }))
const schema = defineSchema({ intents: intents.table, history: history.table })
type DataModel = DataModelFromSchemaDefinition<typeof schema>
type MutationCtx = GenericMutationCtx<DataModel>
type QueryCtx = GenericQueryCtx<DataModel>
const mutation: MutationBuilder<DataModel, 'public'> = mutationGeneric
const internalMutation: MutationBuilder<DataModel, 'internal'> = internalMutationGeneric
const query: QueryBuilder<DataModel, 'public'> = queryGeneric
const triggers = createTriggers<DataModel>()
timestamps(triggers, 'intents', 'history')
noDelete(triggers, 'intents')
triggers.register('intents', async (ctx, change) => {
	if (change.operation === 'insert') await ctx.db.insert('history', { intentId: change.id })
})
const wrapped = effectZodApiBuilder(zCustomMutation(mutation, triggerContext(triggers)), {})
const wrappedQuery = effectZodApiBuilder(zCustomQuery(query, NoOp), {})
const { Command, Query } = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
	},
	writeAudit: () => undefined,
})
const contract = defineDomainContract({
	commands: {
		create: { input: intents.insertSchema, result: intents.schema, classification: 'business' },
	},
	queries: {
		read: { input: z.object({ id: intents.schema.shape._id }), result: intents.schema.nullable() },
	},
})
const commands = Command({
	contract,
	context: (ctx: MutationCtx) => ctx,
	operations: ({ command }) => ({
		create: command.create({
			audit: () => null,
			handler: (input, ctx) =>
				Effect.promise(async () => {
					const id = await ctx.db.insert('intents', input)
					return (await ctx.db.get(id))!
				}),
		}),
	}),
})
const queries = Query({
	contract,
	context: (ctx: QueryCtx) => ctx,
	operations: ({ query }) => ({ read: query.handler(({ id }, ctx) => ctx.db.get(id)) }),
})
const create = wrapped({
	args: intents.insertSchema,
	returns: intents.schema,
	handler: (ctx, input) => commands.exec('create', input, ctx),
})
const read = wrappedQuery({
	args: contract.queries.read.input,
	returns: intents.schema.nullable(),
	handler: (ctx, input) => queries.exec('read', input, ctx),
})
const update = effectZodApiBuilder(
	zCustomMutation(internalMutation, triggerContext(triggers)),
	{},
)({
	args: { id: intents.schema.shape._id, count: z.number() },
	returns: intents.schema,
	handler: async (ctx, { id, count }) => {
		await ctx.db.patch(id, { count })
		return (await ctx.db.get(id))!
	},
})
const remove = customMutation(
	mutation,
	triggerContext(triggers),
)({
	args: {},
	handler: async (ctx) => {
		const row = await ctx.db.query('intents').first()
		await ctx.db.insert('history', { intentId: row!._id })
		await ctx.db.delete(row!._id)
	},
})
const evidence = wrappedQuery({
	args: {},
	returns: z.array(history.schema),
	handler: (ctx) => ctx.db.query('history').take(10),
})
const functions = { create, read, update, remove, evidence }
function setup() {
	const t = convexTest(defineSchema({}), { './_generated/server.ts': async () => ({}) })
	const component = t.registerComponent<ApiFromModules<{ functions: typeof functions }>>(
		'outbox',
		schema,
		{
			'./_generated/server.ts': async () => ({}),
			'./functions.ts': async () => functions,
		},
	)
	return { t, component }
}

describe('cvx-kit in a registered component', () => {
	it('runs timestamps and custom triggers through Effect command and query builders', async () => {
		const { t, component } = setup()
		vi.spyOn(Date, 'now').mockReturnValue(1000)
		try {
			const row = await t.mutation(component.functions.create, { key: 'one', count: 1 })
			expect(row).toMatchObject({ key: 'one', createdAt: 1000, updatedAt: 1000 })
			expect(await t.query(component.functions.read, { id: row._id })).toEqual(row)
			expect(await t.query(component.functions.evidence, {})).toEqual([
				expect.objectContaining({ intentId: row._id, createdAt: 1000, updatedAt: 1000 }),
			])
			vi.mocked(Date.now).mockReturnValue(2000)
			expect(await t.mutation(component.functions.update, { id: row._id, count: 2 })).toMatchObject(
				{ createdAt: 1000, updatedAt: 2000, count: 2 },
			)
		} finally {
			vi.restoreAllMocks()
		}
	})
	it('rolls back writes when a component trigger rejects the mutation', async () => {
		const { t, component } = setup()
		const row = await t.mutation(component.functions.create, { key: 'one', count: 1 })
		await expect(t.mutation(component.functions.remove, {})).rejects.toThrow(
			'intents rows cannot be deleted',
		)
		expect(await t.query(component.functions.read, { id: row._id })).toEqual(row)
		expect(await t.query(component.functions.evidence, {})).toHaveLength(1)
	})
	it('allows old rows without lifecycle timestamps but rejects contracts requiring them', async () => {
		const legacy = { _id: 'legacy', _creationTime: 1, key: 'old', count: 1 }
		expect(intents.schema.safeParse(legacy).success).toBe(true)
		const required = intents.schema.required({ createdAt: true, updatedAt: true })
		expect(required.safeParse(legacy).success).toBe(false)
	})
})
