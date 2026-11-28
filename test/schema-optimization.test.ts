import { expect, test } from 'vite-plus/test'
import { defineSchema } from 'convex/server'
import { compileFilters } from '../src/querying/filters'
import { createPlanner } from '../src/querying/planner'
import { defineRelations, getRelationExecutor } from '../src/relations'
import { k } from '../src/k'
import { kTable, kVariantTable } from '../src/table'

test('planner and direct compiler reject invalid clients and independently enforce stored constraints', () => {
	const items = kTable(
		'items',
		{ name: k.string(), secret: k.string() },
		{ publicFields: ['name'] },
	)
	const registry = defineRelations({ items }, () => ({}))
	const planner = createPlanner(defineSchema({ items: items.table }), registry)
	const input = { numItems: 1, cursor: null, filters: { name: 'visible' } }
	const plan = planner.plan('items', input, [], [{ secret: 'private' }])
	expect(plan.args).toEqual(input)
	expect(plan.bindings.get('name')).toBe('visible')
	expect(plan.bindings.get('secret')).toBe('private')
	expect(planner.plan('items', input, [], [{ name: 'other' }]).unsatisfiable).toBe(true)
	for (const invalid of [
		{ ...input, numItems: 0 },
		{ ...input, filters: { missing: 'x' } },
	]) {
		expect(() => planner.plan('items', invalid, [], [])).toThrow()
		// The standalone compiler remains a validation boundary for its existing callers.
		expect(() =>
			compileFilters(getRelationExecutor(registry).pagination('items'), invalid, []),
		).toThrow()
	}
	expect(() => planner.plan('items', input, [], [{ secret: 123 }])).toThrow()
	expect(() => planner.plan('items', input, [], [{ missing: 'x' }])).toThrow()
})

// v1 also re-read consumer edits to Zod shapes and extension objects on every projection; `k`
// records are immutable, so only the call-site checks below still apply.
test('row projection rejects extension values without an extension schema', () => {
	const items = kTable(
		'items',
		{ name: k.string(), secret: k.string() },
		{ publicFields: ['name'] },
	)
	for (const values of [{ extra: 'unexpected' }, [], 'unexpected', 1]) {
		// @ts-expect-error JavaScript callers can pass unexpected values without an extension.
		expect(() => items.toPublicDto({ name: 'valid', secret: 'private' }, { values })).toThrow()
	}
})

test('variant include-id projection keeps native id validation', () => {
	const items = kVariantTable(
		'items',
		k.discriminatedUnion('type', [
			k.object({ type: k.literal('entry'), name: k.string(), secret: k.string() }),
		]),
		{ discriminator: 'type', variants: { entry: { publicFields: ['name'] } } },
	)
	const row = {
		type: 'entry' as const,
		name: 'ok',
		secret: 'private',
		_id: k.id('items').parse('items:1'),
	}
	expect(items.toPublicDto(row, true)).toEqual({ type: 'entry', name: 'ok', _id: 'items:1' })
	// @ts-expect-error Native ids still reject non-string values at runtime.
	expect(() => items.toPublicDto({ ...row, _id: 42 }, true)).toThrow()
})

test('variant validation must run again after an eligibility callback mutates a validated row', () => {
	const items = kVariantTable(
		'items',
		k.discriminatedUnion('type', [
			k.object({ type: k.literal('entry'), name: k.string(), secret: k.string() }),
		]),
		{ discriminator: 'type', variants: { entry: { publicFields: ['name'] } } },
	)
	const executor = getRelationExecutor(defineRelations({ items }, () => ({})))
	const row = { type: 'entry', name: 'valid', secret: 'private', _id: 'items:1', _creationTime: 1 }
	executor.validateDocument('items', row)
	expect(() =>
		executor.project('items', row, () => {
			Reflect.set(row, 'secret', 42)
			return true
		}),
	).toThrow()
})

test('shared source DTO nodes validate as independent siblings within each helper result', () => {
	// v1 also mutated one helper result's Zod shape; k records are immutable and shared, so each
	// sibling keeps its own declared validation without copies.
	const shared = k.object({ text: k.string() })
	const items = kTable(
		'items',
		{ left: shared, right: shared },
		{ publicFields: ['left', 'right'] },
	)
	const registry = defineRelations({ items }, () => ({}))
	const first = registry.tables.items.pageDto({})
	const page = {
		page: [{ _id: 'items:1', left: { text: 'valid' }, right: { text: 'valid' } }],
		isDone: true,
		continueCursor: '',
	}
	expect(first.safeParse(page).success).toBe(true)
	expect(
		first.safeParse({ ...page, page: [{ ...page.page[0], right: { text: 1 } }] }).success,
	).toBe(false)
	expect(first.safeParse({ ...page, page: [{ ...page.page[0], left: { text: 1 } }] }).success).toBe(
		false,
	)
	expect(
		getRelationExecutor(registry).project(
			'items',
			{
				_id: 'items:1',
				left: { text: 'valid' },
				right: { text: 'valid' },
			},
			() => true,
		),
	).toEqual({ _id: 'items:1', left: { text: 'valid' }, right: { text: 'valid' } })
})
