import { expect, test } from 'vite-plus/test'
import { compileFilters, parseFilterPlan } from '../src/querying/filters'
import { declarations } from './fixture-querying/scalar'

const f = declarations()
const schema = f.tasks.paginationOpts({ department: true, status: true, count: true, big: true })
const indexes = [
	{ name: 'a_eq', fields: ['department'] },
	{ name: 'b_range', fields: ['department', 'count'] },
	{ name: 'c_gap', fields: ['department', 'status', 'count'] },
	{ name: 'd_zero', fields: ['big'] },
]
test('phase A range rank follows equality prefix, strict bounds win ties, explicit ordering wins', () => {
	const args = {
		numItems: 1,
		cursor: null,
		filters: { department: 'a', and: [{ count: { gte: 1, lte: 3 } }, { count: { gt: 1, lt: 3 } }] },
	}
	const p = compileFilters(schema, args, indexes)
	expect(p.index?.name).toBe('b_range')
	expect(p.prefix).toEqual([{ field: 'department', value: 'a' }])
	expect(p.range).toEqual({
		field: 'count',
		lower: { value: 1, inclusive: false },
		upper: { value: 3, inclusive: false },
	})
	expect(parseFilterPlan(schema, args, indexes, [], undefined, 'c_gap').compiled.range).toBeNull()
	expect(parseFilterPlan(schema, args, indexes, [], undefined, 'a_eq').compiled.index?.name).toBe(
		'a_eq',
	)
	expect(
		compileFilters(
			schema,
			{ ...args, filters: { department: 'a', status: 'open', big: { gte: 1n } } },
			indexes,
		).index?.name,
	).toBe('c_gap')
	expect(
		compileFilters(schema, { ...args, filters: { big: { gte: 1n } } }, indexes).index?.name,
	).toBe('d_zero')
})
test('phase A OR/NOT bounds remain residual, server constraints and equality conflicts are combined', () => {
	const input = { numItems: 1, cursor: null }
	for (const filters of [
		{ or: [{ count: { gt: 1 } }, { count: { gt: 1 } }] },
		{ not: { count: { gt: 1 } } },
	]) {
		const p = compileFilters(schema, { ...input, filters }, [{ name: 'count', fields: ['count'] }])
		expect(p.index).toBeNull()
		expect(p.ranges.size).toBe(0)
	}
	const p = compileFilters(schema, { ...input, filters: { count: { gt: 1 } } }, [], [], {
		count: { lte: 1 },
	})
	expect(p.unsatisfiable).toBe(true)
	expect(
		compileFilters(schema, { ...input, filters: { count: 1 } }, [], [], { count: { gt: 1 } })
			.unsatisfiable,
	).toBe(true)
})
