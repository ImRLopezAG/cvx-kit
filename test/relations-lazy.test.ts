// Relation registries do per-table work on first use only. The v1 tests that lived here exercised
// the Zod DTO capture/materialisation mirror (mutated shapes and definitions, z.config hooks, UUID
// constructor failures, branch-object isolation under mutation); `k` records are immutable, so that
// mirror is gone (U13) and those tests went with it. What remains holds for `k` boundaries.
import { defineSchema } from 'convex/server'
import { expect, test, vi } from 'vite-plus/test'
import { v } from 'convex/values'
import { k } from '../src/k'
import { defineRelations, getRelationExecutor, verifyRelations } from '../src/relations'
import { kTable, kVariantTable } from '../src/table'

test.each([1, 2])('pageDto call %i keeps relation validators per variant branch', (call) => {
	const target = kTable('target', { name: k.string() }, { publicFields: ['name'] })
	const source = kVariantTable(
		'source',
		k.discriminatedUnion('kind', [
			k.object({ kind: k.literal('a'), targetId: k.id('target') }),
			k.object({ kind: k.literal('b'), targetId: k.id('target') }),
		]),
		{
			discriminator: 'kind',
			variants: { a: { publicFields: ['targetId'] }, b: { publicFields: ['targetId'] } },
		},
	)
	const registry = defineRelations({ source, target }, (r) => ({
		source: { target: r.one.target({ from: r.source.targetId, to: r.target._id }) },
	}))
	if (call === 2) registry.tables.source.pageDto({ target: true })
	const page = registry.tables.source.pageDto({ target: true })
	const value = { _id: 'target:1', name: 'ok' }
	const rows = [
		{ _id: 'source:1', kind: 'a', targetId: 'target:1', target: value },
		{ _id: 'source:2', kind: 'b', targetId: 'target:1', target: null },
	]
	expect(page.parse({ page: rows, isDone: true, continueCursor: '' }).page).toEqual(rows)
	expect(
		page.safeParse({
			page: [{ ...rows[0], target: { ...value, name: 1 } }],
			isDone: true,
			continueCursor: '',
		}).success,
	).toBe(false)
})

test('U3 full identity binds unused exposure independently of private materialization order', () => {
	function pair(exposeOther = true) {
		const items = kTable('items', { value: k.string() }, { publicFields: ['value'] })
		const other = kTable(
			'other',
			{ label: k.string() },
			{ publicFields: exposeOther ? ['label'] : [] },
		)
		return defineRelations({ items, other }, () => ({}))
	}
	const left = pair(),
		right = pair(),
		before = left.identity
	getRelationExecutor(left).project('other', { _id: 'other:1', label: 'other' }, () => true)
	getRelationExecutor(left).project('items', { _id: 'items:1', value: 'item' }, () => true)
	getRelationExecutor(right).project('items', { _id: 'items:1', value: 'item' }, () => true)
	getRelationExecutor(right).project('other', { _id: 'other:1', label: 'other' }, () => true)
	expect(left.identity).toBe(before)
	expect(right.identity).toBe(before)
	expect(pair(false).identity).not.toBe(before)
})

test('R22: defining relations for 87 tables does no per-table work until a table is first used', () => {
	const fields = {
		tenant: k.string(),
		status: k.string(),
		title: k.string(),
		amount: k.number(),
		tags: k.array(k.string()),
		address: k.object({ city: k.string(), zip: k.string() }).optional(),
	}
	const tables = Object.fromEntries(
		Array.from({ length: 87 }, (_, i) => {
			const name = `table${i}`
			return [name, kTable(name, { ...fields, next: k.id(`table${(i + 1) % 87}`) })]
		}),
	)
	const reads: string[] = []
	const observed = Object.fromEntries(
		Object.entries(tables).map(([name, table]) => [
			name,
			new Proxy(table, {
				get(target, key) {
					if (key === 'table' || key === 'schema' || key === 'dto') reads.push(name)
					// oxlint-disable-next-line anti-slop/no-reflect-get -- The observer forwards every member with the table as receiver.
					return Reflect.get(target, key, target)
				},
			}),
		]),
	)
	const objects = vi.spyOn(v, 'object')
	try {
		// SAFETY: generated table names erase the builder's literal keys; the runtime is the subject.
		const registry = (defineRelations as (...args: never[]) => ReturnType<typeof defineRelations>)(
			observed as never,
			// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Generated table names erase the builder's literal keys.
			((r: Record<string, Record<string, any>>) => ({
				table0: { following: r.one.table1({ from: r.table0.next, to: r.table1._id }) },
			})) as never,
		)
		// Declaration read only the two tables its declarations name, and built no native validator.
		expect(new Set(reads)).toEqual(new Set(['table0', 'table1']))
		expect(objects).not.toHaveBeenCalled()
		reads.length = 0
		registry.tables.table5.pageDto({})
		expect(new Set(reads)).toEqual(new Set(['table5']))
		expect(objects).toHaveBeenCalled()
		void defineSchema(Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, t.table])))
		reads.length = 0
		verifyRelations(registry)
		// Verification materialises every table not yet used (table5 already was).
		expect(new Set([...reads, 'table5']).size).toBe(87)
	} finally {
		objects.mockRestore()
	}
})
