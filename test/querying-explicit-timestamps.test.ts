import { defineSchema, type DataModelFromSchemaDefinition } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { expect, test } from 'vite-plus/test'
import { z } from 'zod'
import { createQueryEngine } from '../src/querying'
import { defineRelations } from '../src/relations-public'
import { zodVariantTable } from '../src/zod-table'
import { cursor, managed, observed } from './fixture-querying/scalar'

test('explicit server timestamps retain native required fields and paginate through the shared engine', async () => {
	const ledger = zodVariantTable(
		'ledger',
		z.discriminatedUnion('type', [
			z.strictObject({
				type: z.literal('adjustment'),
				createdAt: z.int().nonnegative(),
				recordedAt: z.int().nonnegative(),
			}),
			z.strictObject({
				type: z.literal('payment'),
				createdAt: z.int().nonnegative(),
				recordedAt: z.int().nonnegative(),
			}),
		]),
		{
			discriminator: 'type',
			timestamps: false,
			variants: {
				adjustment: { serverFields: ['createdAt', 'recordedAt'], publicFields: ['createdAt'] },
				payment: { serverFields: ['createdAt', 'recordedAt'], publicFields: [] },
			},
		},
	)
	const schema = defineSchema({
		ledger: ledger.table
			.index('by_createdAt', ['createdAt'])
			.index('by_type_createdAt', ['type', 'createdAt']),
	})
	const relations = defineRelations({ ledger }, () => ({}))
	const t = defineTestApp({ schema }).defineModules({}).createTest()
	const querying = createQueryEngine({ schema, relations }, { cursor })
	const ids = await t.run(async (ctx) => [
		await ctx.db.insert(
			'ledger',
			ledger.storage.parse({ type: 'adjustment', createdAt: 0, recordedAt: 10 }),
		),
		await ctx.db.insert(
			'ledger',
			ledger.storage.parse({ type: 'payment', createdAt: 1, recordedAt: 11 }),
		),
		await ctx.db.insert(
			'ledger',
			ledger.storage.parse({ type: 'adjustment', createdAt: 2, recordedAt: 12 }),
		),
	])
	await expect(
		t.run((ctx) =>
			// @ts-expect-error hostile insert bypasses the Zod boundary to test native requiredness
			ctx.db.insert('ledger', { type: 'adjustment', recordedAt: 10 }),
		),
	).rejects.toThrow()
	await expect(
		t.run((ctx) =>
			// @ts-expect-error hostile insert tests native number validation independently of Zod
			ctx.db.insert('ledger', { type: 'adjustment', createdAt: '0', recordedAt: 10 }),
		),
	).rejects.toThrow()
	for (const order of ['asc', 'desc'] as const)
		await t.run(async (ctx) => {
			const o = observed<DataModelFromSchemaDefinition<typeof schema>>(ctx.db)
			const q = querying(managed(o.raw)).ledger
			const page = await q
				.orderBy('by_createdAt')
				.where({ recordedAt: { gte: 10 } })
				.paginate({ numItems: 100, cursor: null, order, filters: { createdAt: { gte: 0, lt: 2 } } })
			expect(page.page.map((r) => r._id)).toEqual(
				order === 'asc' ? ids.slice(0, 2) : ids.slice(0, 2).reverse(),
			)
			expect(o.counts.returned).toBe(2)
			const before = o.counts.returned
			const scoped = await q
				.orderBy('by_type_createdAt')
				.where({ variant: { tag: 'adjustment', filters: { createdAt: { gte: 1, lte: 2 } } } })
				.paginate({ numItems: 100, cursor: null, order })
			expect(scoped.page.map((r) => r._id)).toEqual([ids[2]])
			expect(o.counts.returned - before).toBe(1)
			expect(scoped.page[0]).not.toHaveProperty('recordedAt')
		})
	const first = await t.run((ctx) =>
		querying(managed<DataModelFromSchemaDefinition<typeof schema>>(ctx.db)).ledger.paginate({
			numItems: 1,
			cursor: null,
		}),
	)
	const second = await t.run((ctx) =>
		querying(managed<DataModelFromSchemaDefinition<typeof schema>>(ctx.db)).ledger.paginate({
			numItems: 1,
			cursor: first.continueCursor,
		}),
	)
	const third = await t.run((ctx) =>
		querying(managed<DataModelFromSchemaDefinition<typeof schema>>(ctx.db)).ledger.paginate({
			numItems: 1,
			cursor: second.continueCursor,
		}),
	)
	const end = await t.run((ctx) =>
		querying(managed<DataModelFromSchemaDefinition<typeof schema>>(ctx.db)).ledger.paginate({
			numItems: 1,
			cursor: third.continueCursor,
		}),
	)
	expect([...first.page, ...second.page, ...third.page].map((row) => row._id)).toEqual(ids)
	expect(first.isDone).toBe(false)
	expect(second.isDone).toBe(false)
	expect(end.isDone).toBe(true)
	expect(end.page).toEqual([])
	expect(first.page[0]).toEqual({ _id: ids[0], type: 'adjustment', createdAt: 0 })
	expect(second.page[0]).toEqual({ _id: ids[1], type: 'payment' })
	expect(third.page[0]).toEqual({ _id: ids[2], type: 'adjustment', createdAt: 2 })
	for (const result of [first, second, third]) {
		expect(relations.tables.ledger.pageDto({}).parse(result)).toEqual(result)
		for (const row of result.page) {
			expect(row).not.toHaveProperty('recordedAt')
			expect(row).not.toHaveProperty('updatedAt')
			expect(row).not.toHaveProperty('archivedAt')
		}
	}
})
