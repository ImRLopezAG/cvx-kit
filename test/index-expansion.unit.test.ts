import { expect, test } from 'vite-plus/test'
import { parseFilterPlan } from '../src/querying/filters'
import type { z } from 'zod'
import { declarations } from './fixture-querying/scalar'
const f = declarations()
const schema = f.tasks.paginationOpts({ department: true, count: true, status: true })
const indexes = [{ name: 'by_department_count', fields: ['department', 'count'] }]
test('U4 normalizes eligible sets, selects one position and keeps other OR residual', () => {
	const plan = (filters: z.input<typeof schema>['filters'], ordering?: string) =>
		parseFilterPlan(
			schema,
			{ numItems: 2, cursor: null, filters },
			indexes,
			[],
			undefined,
			ordering,
		).compiled
	const p = plan({ department: { in: ['b', 'a', 'b'] }, count: { gte: 1 } })
	expect(p.index?.name).toBe('by_department_count')
	expect(p.expansion).toEqual({ field: 'department', values: ['a', 'b'], comparator: 'tail' })
	expect(
		plan({ or: [{ department: 'b' }, { department: 'a' }, { department: 'a' }] }).expansion,
	).toEqual(p.expansion)
	expect(
		plan({ department: { in: ['a', 'b'] } }, 'by_department_count').expansion?.comparator,
	).toBe('full-index')
	expect(plan({ or: [{ department: 'a' }, { status: 'open' }] }).expansion).toBeNull()
	expect(plan({ department: { in: [] } }).unsatisfiable).toBe(true)
	expect(() =>
		plan({ department: { in: Array.from({ length: 9 }, (_, i) => String(i)) } }),
	).toThrow('QUERY_FANOUT')
	expect(
		plan(
			{ department: { in: Array.from({ length: 9 }, (_, i) => String(i)) } },
			'by_department_count',
		).expansion,
	).toBeNull()
})

test('U4 intersects sets with equality/ranges without Cartesian expansion', () => {
	const plan = (filters: z.input<typeof schema>['filters']) =>
		parseFilterPlan(schema, { numItems: 1, cursor: null, filters }, indexes).compiled
	expect(
		plan({ and: [{ department: { in: ['a', 'b'] } }, { department: { in: ['b', 'c'] } }] })
			.expansion?.values,
	).toEqual(['b'])
	expect(plan({ department: { in: ['a', 'b'], gt: 'b' } }).unsatisfiable).toBe(true)
	expect(plan({ department: { in: ['a', 'b'] }, count: { in: [1, 2] } }).prefix).toEqual([])
	expect(plan({ department: { in: ['a', 'b'] }, count: { in: [1, 2] } }).expansion?.field).toBe(
		'department',
	)
})

test('U4 selective large fixture counts native candidates including prefetched leaves', async () => {
	const { harness, seed, managed, observed } = await import('./fixture-querying/scalar')
	const f = harness()
	await seed(f, 1500)
	await f.t.run(async (ctx) => {
		const o = observed(ctx.db)
		const page = await f
			.querying(managed(o.raw))
			.tasks.paginate({ numItems: 10, cursor: null, filters: { big: { in: [4n, 900n, 1400n] } } })
		expect(page.page.map((row) => row.ordinal)).toEqual([4, 900, 1400])
		expect(o.counts).toEqual({ returned: 3, next: 6, ranges: 3, gets: 0, closes: 3 })
	})
})

test('U4 every 2..8 nonempty value set returns all roots once in tail order', async () => {
	const { harness, seed, managed } = await import('./fixture-querying/scalar')
	const f = harness()
	const rows = await seed(f, 64)
	await f.t.run(async (ctx) => {
		for (const row of rows) await ctx.db.patch(row._id, { department: String(row.ordinal % 8) })
		for (let size = 2; size <= 8; size++) {
			const values = Array.from({ length: size }, (_, i) => String(i))
			const page = await f
				.querying(managed(ctx.db))
				.tasks.paginate({ numItems: 100, cursor: null, filters: { department: { in: values } } })
			expect(page.page.map((row) => row.ordinal)).toEqual(
				rows.filter((row) => row.ordinal % 8 < size).map((row) => row.ordinal),
			)
			expect(new Set(page.page.map((row) => row._id)).size).toBe(page.page.length)
		}
	})
})
