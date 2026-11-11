import { createHash } from 'node:crypto'
import { expect, test, vi } from 'vite-plus/test'
import { z } from 'zod'
import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { compactArgumentBoundary } from '../src/querying/filter-boundary'
import { defineRelations } from '../src/relations'
import { zodToConvex } from '../src/zod-convex'
import { zid, zodTable, zodVariantTable } from '../src/zod-table'

const counts = vi.hoisted(() => ({ captureDto: 0, materializeDto: 0 }))
vi.mock('../src/querying/schema-snapshot', async (load) => {
	const actual = await load<typeof import('../src/querying/schema-snapshot')>()
	return {
		...actual,
		captureDto: ((schema) => {
			counts.captureDto++
			return actual.captureDto(schema)
		}) satisfies typeof actual.captureDto,
		materializeDto: ((recipe) => {
			counts.materializeDto++
			return actual.materializeDto(recipe)
		}) satisfies typeof actual.materializeDto,
	}
})

function fixture() {
	const target = zodTable('target', () => ({ name: z.string(), rank: z.number() }), {
		publicFields: ['name', 'rank'],
	})
	const items = zodTable(
		'items',
		() => ({ title: z.string(), count: z.number(), secret: z.string(), targetId: zid('target') }),
		{ publicFields: ['title', 'count', 'targetId'] },
	)
	const source = zodVariantTable(
		'source',
		z.discriminatedUnion('kind', [
			z.strictObject({ kind: z.literal('a'), amount: z.number(), targetId: zid('target') }),
			z.strictObject({ kind: z.literal('b'), label: z.string(), targetId: zid('target') }),
		]),
		{
			discriminator: 'kind',
			variants: {
				a: { publicFields: ['amount', 'targetId'] },
				b: { publicFields: ['label', 'targetId'] },
			},
		},
	)
	return defineRelations(
		{ source, target, items: { ...items, fieldGroups: { private: ['secret'] } } },
		(r) => ({
			items: { target: r.one.target({ from: r.items.targetId, to: r.target._id }) },
			source: { target: r.one.target({ from: r.source.targetId, to: r.target._id }) },
		}),
	)
}
type Registry = ReturnType<typeof fixture>

function json(validator: GenericValidator): ValidatorJSON {
	// SAFETY: Convex exposes converter JSON at runtime but omits it from public declarations.
	return (validator as GenericValidator & { json: ValidatorJSON }).json
}

const optionInputs = [
	{ numItems: 5, cursor: null },
	{ numItems: 5, cursor: null, order: 'desc' },
	{ numItems: 5, cursor: null, order: 'sideways' },
	{ numItems: 5, cursor: null, filters: { title: 'x' } },
	{ numItems: 5, cursor: null, filters: { title: 1 } },
	{ numItems: 5, cursor: null, filters: { count: { gt: 1 } } },
	{ numItems: 5, cursor: null, filters: { unknown: 1 } },
	{ numItems: 5, cursor: null, filters: { target: { name: 'n' } } },
	{ numItems: 5, cursor: null, filters: { target: { name: 2 } } },
	{ numItems: 5, cursor: null, filters: { not: { title: 'x' } } },
	{ numItems: 5, cursor: null, filters: { amount: { gt: 1 } } },
	{ numItems: 5, cursor: null, filters: { variants: { a: { amount: 1 } } } },
	{ numItems: 5, cursor: null, filters: { variants: { b: { label: 'l' } } } },
	{ numItems: 5, cursor: null, filters: { variants: { c: {} } } },
	{ numItems: 'many', cursor: null },
]
const page = (rows: unknown[]) => ({ page: rows, isDone: true, continueCursor: '' })
const pageInputs = [
	page([]),
	page([{ _id: 'items:1', title: 't', count: 1, targetId: 'target:1' }]),
	page([{ _id: 'items:1', title: 2, count: 1, targetId: 'target:1' }]),
	page([
		{
			_id: 'items:1',
			_creationTime: 1,
			title: 't',
			count: 1,
			targetId: 'target:1',
			target: { _id: 'target:1', name: 'n', rank: 1 },
			secret: 's',
		},
	]),
	page([{ _id: 'items:1', title: 't', count: 1, targetId: 'target:1', target: null }]),
	page([{ _id: 'source:1', kind: 'a', amount: 1, targetId: 'target:1' }]),
	page([
		{
			_id: 'source:1',
			_creationTime: 1,
			kind: 'b',
			label: 'l',
			targetId: 'target:1',
			target: { _id: 'target:1', name: 'n', rank: 1 },
		},
	]),
	page([{ _id: 'source:1', kind: 'c' }]),
	{ page: 'nope' },
]

function observe(schema: z.ZodType, inputs: readonly unknown[]) {
	return {
		parses: inputs.map((input) => {
			const result = schema.safeParse(input)
			return result.success
				? { ok: true, data: result.data }
				: { ok: false, issues: result.error.issues.map(({ code, path }) => ({ code, path })) }
		}),
		convex: json(zodToConvex(schema)),
		jsonSchema: z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
	}
}

type Case = readonly [string, (registry: Registry) => z.ZodType, readonly unknown[]]
const cases: Case[] = [
	['paginationOpts scalar', (r) => r.tables.items.paginationOpts({ title: true, count: true }), optionInputs],
	[
		'paginationOpts relation join',
		(r) => r.tables.items.paginationOpts({ title: true, target: { name: true } }),
		optionInputs,
	],
	[
		'paginationOpts variant selection',
		(r) =>
			r.tables.source.paginationOpts({
				target: { name: true },
				variants: { a: { amount: true }, b: { label: true } },
			}),
		optionInputs,
	],
	[
		'paginationOpts compact',
		(r) => r.tables.items.paginationOpts({ title: true, target: { name: true } }, { validator: 'compact' }),
		optionInputs,
	],
	['pageDto scalar', (r) => r.tables.items.pageDto({}), pageInputs],
	['pageDto relation join', (r) => r.tables.items.pageDto({ target: true }), pageInputs],
	['pageDto variant', (r) => r.tables.source.pageDto({}), pageInputs],
	['pageDto variant relation', (r) => r.tables.source.pageDto({ target: true }), pageInputs],
	['pageDto field groups', (r) => r.tables.items.pageDto({}, { fieldGroups: { private: 'required' } }), pageInputs],
]

test.each(cases)('%s: calls 1, 2 and 3 validate identically', (_, build, inputs) => {
	const registry = fixture()
	const first = observe(build(registry), inputs)
	// The digest pins validation results and schema descriptions recorded before the first-call change.
	expect(createHash('sha256').update(JSON.stringify(first)).digest('hex')).toMatchSnapshot()
	expect(observe(build(registry), inputs)).toEqual(first)
	expect(observe(build(registry), inputs)).toEqual(first)
})

test.each(cases)('%s: mutating an earlier call never reaches a later call', (_, build, inputs) => {
	const registry = fixture()
	const baseline = observe(build(fixture()), inputs)
	const calls = [build(registry), build(registry), build(registry)]
	for (const [index, schema] of calls.entries()) {
		expect(observe(schema, inputs)).toEqual(baseline)
		if (!(schema instanceof z.ZodObject)) throw new Error('Expected object schema')
		schema.extend({ page: z.never(), filters: z.never(), numItems: z.never() })
		for (const key of Object.keys(schema.shape)) Reflect.set(schema.shape, key, z.never())
		for (const later of calls.slice(index + 1)) expect(observe(later, inputs)).toEqual(baseline)
	}
})

test('call 1 of a variant page isolates a selected relation between branches', () => {
	const schema = fixture().tables.source.pageDto({ target: true })
	if (!(schema instanceof z.ZodObject) || !(schema.shape.page instanceof z.ZodArray))
		throw new Error('Expected page')
	const row = schema.shape.page.element
	if (!(row instanceof z.ZodDiscriminatedUnion)) throw new Error('Expected variant rows')
	const [a, b] = row.options.map((option) => {
		if (!(option instanceof z.ZodObject) || !(option.shape.target instanceof z.ZodNullable))
			throw new Error('Expected relation')
		const target = option.shape.target.unwrap()
		if (!(target instanceof z.ZodObject)) throw new Error('Expected relation object')
		return target
	})
	expect(a).not.toBe(b)
	a.shape.name = z.number()
	const value = { _id: 'target:1', name: 'n', rank: 1 }
	expect(a.safeParse(value).success).toBe(false)
	expect(b.parse(value)).toEqual(value)
})

test('compact options from every call carry compact metadata for the argument boundary', () => {
	const registry = fixture()
	for (let call = 0; call < 3; call++) {
		const schema = registry.tables.items.paginationOpts(
			{ title: true, target: { name: true } },
			{ validator: 'compact' },
		)
		if (!(schema instanceof z.ZodObject)) throw new Error('Expected object schema')
		const boundary = compactArgumentBoundary(z.object({ ...schema.shape }))
		expect(boundary).toBeDefined()
	}
})

test('first ordinary calls skip recipe capture; later calls capture', () => {
	const registry = fixture()
	// Warm per-table first use so only the helper's own capture is counted.
	registry.tables.items.paginationOpts({ count: true })
	registry.tables.target.pageDto({})
	const before = counts.captureDto
	registry.tables.items.pageDto({})
	registry.tables.items.paginationOpts({ title: true, target: { name: true } })
	expect(counts.captureDto - before).toBe(0)
	registry.tables.items.pageDto({})
	registry.tables.items.paginationOpts({ title: true, target: { name: true } })
	expect(counts.captureDto - before).toBeGreaterThan(0)
	const third = counts.captureDto
	registry.tables.items.pageDto({})
	registry.tables.items.paginationOpts({ title: true, target: { name: true } })
	expect(counts.captureDto).toBe(third)
})

test('variant and relation pages keep capturing on the first call', () => {
	const registry = fixture()
	registry.tables.items.pageDto({}, { fieldGroups: { private: 'required' } })
	registry.tables.source.pageDto({})
	registry.tables.target.pageDto({})
	for (const build of [
		() => registry.tables.items.pageDto({ target: true }),
		() => registry.tables.source.pageDto({ target: true }),
	]) {
		const before = counts.captureDto
		build()
		expect(counts.captureDto).toBeGreaterThan(before)
	}
})

function secondCallMaterializations(trip: boolean) {
	const registry = fixture()
	registry.tables.items.pageDto({})
	const previous = z.config().postProcessor
	if (trip) z.config({ postProcessor: () => {} })
	try {
		const before = counts.materializeDto
		const second = registry.tables.items.pageDto({})
		return { count: counts.materializeDto - before, second }
	} finally {
		z.config({ postProcessor: previous })
	}
}

test('an unaudited Zod environment keeps call 2 on the materialize path', () => {
	const ordinary = secondCallMaterializations(false)
	const tripped = secondCallMaterializations(true)
	expect(tripped.count).toBe(ordinary.count + 1)
	expect(observe(tripped.second, pageInputs)).toEqual(observe(ordinary.second, pageInputs))
})
