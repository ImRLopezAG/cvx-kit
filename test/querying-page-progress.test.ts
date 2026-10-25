import { expect, test } from 'vite-plus/test'
import { anyApi, defineSchema, type DataModelFromSchemaDefinition } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { z } from 'zod'
import { zodTable } from '../src/zod-table'
import { defineRelations } from '../src/relations'
import { getDocumentSize } from 'convex/values'
import { createQueryEngine } from '../src/querying'
import { MAX_DOCUMENT_BYTES, ManagedReadError } from '../src/querying/security'
import { harness, seed, managed, observed, cursor } from './fixture-querying/scalar'
import { authenticatedFixture } from './fixture-querying/auth'
import { relationshipFixture, seedRelationships } from './fixture-querying/relationships'
import { relationshipAuthFixture } from './fixture-querying/relationships-auth'

test('U3 registered all-denied default pages already split and continue; opt-in preserves progress', async () => {
	const f = authenticatedFixture({ readOperations: 2 })
	await seed(f, 5)
	const client = f.t.withIdentity({ subject: 'user', org_id: 'one', role: 'owner' })
	const first = await client.query(anyApi.functions.composed, { numItems: 10, cursor: null })
	expect(first.page).toEqual([])
	expect(first.isDone).toBe(false)
	expect(first.pageStatus).toBe('SplitRequired')
	const next = await client.query(anyApi.functions.composed, {
		numItems: 10,
		cursor: first.continueCursor,
		onEmptyBudget: 'split',
	})
	expect(next.page).toEqual([])
	expect(next.isDone).toBe(false)
	expect(next.continueCursor).not.toBe(first.continueCursor)
	expect(first.completeness).toBe('row-budget')
	expect(next.completeness).toBe('row-budget')
})

test('U3 actual row, byte and native stops differ; full requested pages are complete', async () => {
	const f = harness()
	const rows = await seed(f, 5)
	for (const [budgets, args, reason, size] of [
		[{ readOperations: 2 }, {}, 'row-budget', 2],
		[{ documentBytes: MAX_DOCUMENT_BYTES + getDocumentSize(rows[0]) - 1 }, {}, 'byte-budget', 1],
		[{ readOperations: 2 }, { maximumRowsRead: 1 }, 'native-limit', 1],
		[{ rawCandidates: 2 }, {}, 'native-limit', 2],
		[
			{ readOperations: 1, documentBytes: MAX_DOCUMENT_BYTES + getDocumentSize(rows[0]) - 1 },
			{},
			'row-budget',
			1,
		],
		[
			{ documentBytes: MAX_DOCUMENT_BYTES + getDocumentSize(rows[0]) - 1 },
			{ maximumRowsRead: 1 },
			'native-limit',
			1,
		],
		[{}, { maximumBytesRead: 1 }, 'native-limit', 1],
		[{ readOperations: 1 }, { numItems: 1 }, 'complete', 1],
		[{ rawCandidates: 1 }, { numItems: 1 }, 'complete', 1],
		[{}, {}, 'complete', 5],
	] as const) {
		const engine = createQueryEngine({ schema: f.schema, relations: f.relations, cursor, budgets })
		await f.t.run(async (ctx) => {
			const page = await engine(managed(ctx.db)).tasks.paginate({
				numItems: 10,
				cursor: null,
				...args,
			})
			expect(page.page).toHaveLength(size)
			expect(page.completeness).toBe(reason)
			if (reason !== 'complete') expect(page.isDone).toBe(false)
		})
	}
})

test('U3 progressing residual rejection retains split/end intervals and resumes every row', async () => {
	const f = harness()
	const rows = await seed(f, 6)
	const engine = createQueryEngine({
		schema: f.schema,
		relations: f.relations,
		cursor,
		budgets: { readOperations: 3 },
	})
	const first = await f.t.run((ctx) =>
		engine(managed(ctx.db))
			.tasks.where({ ordinal: { gte: 2 } })
			.paginate({ numItems: 10, cursor: null, onEmptyBudget: 'split' }),
	)
	expect(first.completeness).toBe('row-budget')
	expect(first.page.map((r) => r._id)).toEqual([rows[2]._id])
	await f.t.run(async (ctx) => {
		const q = f.querying(managed(ctx.db)).tasks.where({ ordinal: { gte: 2 } })
		const left = await q.paginate({ numItems: 1, cursor: null, endCursor: first.splitCursor })
		const right = await q.paginate({
			numItems: 1,
			cursor: first.splitCursor!,
			endCursor: first.continueCursor,
		})
		expect([...left.page, ...right.page]).toEqual(first.page)
		expect(left.completeness).toBe('complete')
		expect(right.completeness).toBe('complete')
		const tail = await q.paginate({ numItems: 10, cursor: first.continueCursor })
		expect(tail.page.map((r) => r._id)).toEqual(rows.slice(3).map((r) => r._id))
		expect(tail.isDone).toBe(true)
		const empty = await q.paginate({
			numItems: 1,
			cursor: first.continueCursor,
			endCursor: first.continueCursor,
		})
		expect(empty.page).toEqual([])
		expect(empty.completeness).toBe('complete')
		expect(empty.isDone).toBe(false)
		expect(empty.continueCursor).toBe(first.continueCursor)
	})
	const intervalEngine = createQueryEngine({
		schema: f.schema,
		relations: f.relations,
		cursor,
		budgets: { readOperations: 4 },
	})
	const bounded = await f.t.run((ctx) =>
		intervalEngine(managed(ctx.db))
			.tasks.where({ ordinal: { gte: 2 } })
			.paginate({ numItems: 1, cursor: null, endCursor: first.continueCursor }),
	)
	expect(bounded.page).toEqual(first.page)
	expect(bounded.completeness).toBe('complete')
})

test('U3 opt-in cannot turn zero progress, unfinished policy or DTO failure into success', async () => {
	const f = harness()
	const rows = await seed(f, 3)
	for (const budgets of [{ documentBytes: MAX_DOCUMENT_BYTES - 1 }, { readOperations: 2 }]) {
		const engine = createQueryEngine({ schema: f.schema, relations: f.relations, cursor, budgets })
		await f.t.run(async (ctx) => {
			const o = observed(ctx.db)
			await expect(
				engine(
					managed(o.raw, {
						tasks: {
							read: async ({ db }, row) => {
								if (row.ordinal === 1) await db.get('tasks', rows[2]._id)
								return true
							},
						},
					}),
				).tasks.paginate({ numItems: 10, cursor: null, onEmptyBudget: 'split' }),
			).rejects.toThrow('MANAGED_READ_BUDGET')
		})
	}
	await f.t.run(async (ctx) => {
		const o = observed(ctx.db)
		await expect(
			f
				.querying(
					managed(o.raw, {
						tasks: {
							read: async (_ctx, row) => {
								if (row.ordinal === 1) throw new ManagedReadError('MANAGED_READ_BUDGET')
								return true
							},
						},
					}),
				)
				.tasks.paginate({ numItems: 10, cursor: null, onEmptyBudget: 'split' }),
		).rejects.toThrow('MANAGED_READ_BUDGET')
		expect(o.counts.closes).toBe(1)
	})
	const items = zodTable('items', () => ({ ordinal: z.number().refine((value) => value !== 1) }), {
		publicFields: ['ordinal'],
	})
	const schema = defineSchema({ items: items.table })
	const relations = defineRelations({ items }, () => ({}))
	const engine = createQueryEngine({ schema, relations, cursor })
	const { createTest } = defineTestApp({ schema }).defineModules({})
	await createTest().run(async (ctx) => {
		// Native storage accepts numbers; DTO refinement rejects the second candidate.
		await ctx.db.insert('items', { ordinal: 0 })
		await ctx.db.insert('items', { ordinal: 1 })
		await expect(
			engine(managed<DataModelFromSchemaDefinition<typeof schema>>(ctx.db)).items.paginate({
				numItems: 10,
				cursor: null,
				onEmptyBudget: 'split',
			}),
		).rejects.toThrow('Query execution failed')
	})
})

test('U3 direct and registered through-relation empty progress resumes at completed keys', async () => {
	const registered = relationshipAuthFixture({ budgets: { readOperations: 3 } })
	const roots = await seedRelationships(registered)
	const client = registered.t.withIdentity({ subject: 'user', org_id: 'one', role: 'owner' })
	const through = await client.query(anyApi.functions.next, {
		parent: roots.tasks[1]._id,
		numItems: 100,
		cursor: null,
		onEmptyBudget: 'split',
	})
	expect(through.page).toEqual([])
	expect(through.completeness).toBe('row-budget')
	expect(through.isDone).toBe(false)
	expect(through.splitCursor).toBe(through.continueCursor)
	const f = relationshipFixture()
	const rows = await seedRelationships(f)
	for (const [path, budget] of [
		['direct', 2],
		['labels', 3],
	] as const) {
		const limited = createQueryEngine({
			schema: f.schema,
			relations: f.relations,
			cursor,
			budgets: { readOperations: budget },
		})
		const first = await f.t.run((ctx) =>
			limited(f.context(ctx.db).ctx)
				.tasks.relation(rows.tasks[1]._id, path)
				.paginate({ numItems: 100, cursor: null, onEmptyBudget: 'split' }),
		)
		expect(first.page).toEqual([])
		expect(first.completeness).toBe('row-budget')
		expect(first.isDone).toBe(false)
		await f.t.run(async (ctx) => {
			const q = f.querying(f.context(ctx.db).ctx).tasks.relation(rows.tasks[1]._id, path)
			const full = await q.paginate({ numItems: 100, cursor: null })
			const tail = await q.paginate({ numItems: 100, cursor: first.continueCursor })
			expect(tail.page).toEqual(full.page)
			expect(tail.completeness).toBe('complete')
			expect(tail.isDone).toBe(true)
			const interval = await q.paginate({
				numItems: 1,
				cursor: null,
				endCursor: first.continueCursor,
			})
			expect(interval.page).toEqual([])
			expect(interval.completeness).toBe('complete')
		})
	}
})
