import { expect, test } from 'vite-plus/test'
import { defineSchema } from 'convex/server'
import { z } from 'zod'
import { compileFilters } from '../src/querying/filters'
import { createPlanner } from '../src/querying/planner'
import { defineRelations, getRelationExecutor } from '../src/relations'
import { zodTable, zodVariantTable } from '../src/zod-table'

test('planner and direct compiler reject invalid clients and independently enforce stored constraints', () => {
	const items = zodTable('items', () => ({ name: z.string(), secret: z.string() }), {
		publicFields: ['name'],
	})
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

test('row projection observes mutable public and extension declarations on every call', () => {
	let checks = 0
	const items = zodTable(
		'items',
		() => ({
			name: z
				.string()
				.default('default')
				.refine((value) => {
					checks++
					return value !== 'bad'
				}),
			secret: z.string(),
		}),
		{ publicFields: ['name'] },
	)
	const row = { secret: 'private' }
	expect(items.toPublicDto(row)).toEqual({ name: 'default' })
	expect(checks).toBe(1)
	const extend = { extra: z.string() }
	expect(items.toPublicDto(row, { extend, values: { extra: 'ok' } })).toEqual({
		name: 'default',
		extra: 'ok',
	})
	extend.extra = z.string().min(3)
	expect(() => items.toPublicDto(row, { extend, values: { extra: 'ok' } })).toThrow()
	Reflect.set(extend, 'name', z.string())
	expect(() => items.toPublicDto(row, { extend, values: { extra: 'long' } })).toThrow(/collision/)
	Reflect.set(items.publicDto.shape, 'name', z.string().min(4))
	expect(() => items.toPublicDto({ name: 'abc', secret: 'private' })).toThrow()
	for (const values of [{ extra: 'unexpected' }, [], 'unexpected', 1]) {
		// @ts-expect-error JavaScript callers can pass unexpected values without an extension.
		expect(() => items.toPublicDto({ name: 'valid', secret: 'private' }, { values })).toThrow()
	}
})

function variantItems() {
	return zodVariantTable(
		'items',
		z.discriminatedUnion('type', [
			z.strictObject({ type: z.literal('entry'), name: z.string(), secret: z.string() }),
		]),
		{ discriminator: 'type', variants: { entry: { publicFields: ['name'] } } },
	)
}

test('variant include-id projection observes later branch edits and keeps native id validation', () => {
	const items = variantItems()
	const row = { type: 'entry' as const, name: 'ok', secret: 'private', _id: 'items:1' }
	expect(items.toPublicDto(row, true)).toEqual({ type: 'entry', name: 'ok', _id: 'items:1' })
	// A returned helper must not expose the projector's private ID validator.
	const exposed = items.dto(true)
	Reflect.set(exposed.options[0].shape, '_id', z.number())
	expect(items.toPublicDto(row, true)._id).toBe('items:1')
	Reflect.set(items.publicDto.options[0].shape, 'name', z.string().min(4))
	expect(() => items.toPublicDto(row, true)).toThrow()
	expect(items.toPublicDto({ ...row, name: 'valid' }, true).name).toBe('valid')
	// @ts-expect-error Native IDs still reject non-string values at runtime.
	expect(() => items.toPublicDto({ ...row, name: 'valid', _id: 42 }, true)).toThrow()
})

test('variant validation must run again after an eligibility callback mutates a validated row', () => {
	const items = variantItems()
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

test('shared source DTO nodes restore as independent siblings within each helper result', () => {
	const shared = z.object({ text: z.string() })
	const items = zodTable('items', () => ({ left: shared, right: shared }), {
		publicFields: ['left', 'right'],
	})
	const registry = defineRelations({ items }, () => ({}))
	const first = registry.tables.items.pageDto({})
	const second = registry.tables.items.pageDto({})
	if (!(first instanceof z.ZodObject)) throw new Error('Expected object page DTO')
	Reflect.set(first.shape.page.element.shape.left.shape, 'text', z.number())
	const page = {
		page: [{ _id: 'items:1', left: { text: 1 }, right: { text: 'valid' } }],
		isDone: true,
		continueCursor: '',
	}
	expect(first.safeParse(page).success).toBe(true)
	expect(
		first.safeParse({ ...page, page: [{ ...page.page[0], right: { text: 1 } }] }).success,
	).toBe(false)
	expect(second.safeParse(page).success).toBe(false)
	expect(registry.tables.items.pageDto({}).safeParse(page).success).toBe(false)
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
