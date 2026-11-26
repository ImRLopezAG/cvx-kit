import { expect, test } from 'vite-plus/test'
import { k, type KType } from '../src/k'
import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { compactArgumentBoundary } from '../src/querying/filter-boundary'
import { defineRelations, withFieldGroups } from '../src/relations'
import { kTable, kVariantTable } from '../src/table'

function fixture() {
	const target = kTable(
		'target',
		{ name: k.string(), rank: k.number() },
		{
			publicFields: ['name', 'rank'],
		},
	)
	const items = kTable(
		'items',
		{ title: k.string(), count: k.number(), secret: k.string(), targetId: k.id('target') },
		{ publicFields: ['title', 'count', 'targetId'] },
	)
	const source = kVariantTable(
		'source',
		k.discriminatedUnion('kind', [
			k.object({ kind: k.literal('a'), amount: k.number(), targetId: k.id('target') }),
			k.object({ kind: k.literal('b'), label: k.string(), targetId: k.id('target') }),
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
		{ source, target, items: withFieldGroups(items, { private: ['secret'] }) },
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

function observe(built: KType, inputs: readonly unknown[]) {
	const schema = schemaOf(built)
	return {
		parses: inputs.map((input) => {
			const result = schema.safeParse(input)
			return result.success
				? { ok: true, data: result.data }
				: { ok: false, issues: result.issues.map(({ code, path }) => ({ code, path })) }
		}),
		convex: json(built.validator),
	}
}

function schemaOf(schema: KType) {
	// SAFETY: every KType at runtime is a k schema record with safeParse.
	return schema as ReturnType<typeof k.any>
}

type Case = readonly [string, (registry: Registry) => KType, readonly unknown[]]
const cases: Case[] = [
	[
		'paginationOpts scalar',
		(r) => r.tables.items.paginationOpts({ title: true, count: true }),
		optionInputs,
	],
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
		(r) =>
			r.tables.items.paginationOpts(
				{ title: true, target: { name: true } },
				{ validator: 'compact' },
			),
		optionInputs,
	],
	['pageDto scalar', (r) => r.tables.items.pageDto({}), pageInputs],
	['pageDto relation join', (r) => r.tables.items.pageDto({ target: true }), pageInputs],
	['pageDto variant', (r) => r.tables.source.pageDto({}), pageInputs],
	['pageDto variant relation', (r) => r.tables.source.pageDto({ target: true }), pageInputs],
	[
		'pageDto field groups',
		(r) => r.tables.items.pageDto({}, { fieldGroups: { private: 'required' } }),
		pageInputs,
	],
]

test.each(cases)('%s: calls 1, 2 and 3 validate identically', (_, build, inputs) => {
	const registry = fixture()
	const first = observe(build(registry), inputs)
	// v1 also pinned a digest of Zod issue codes and Zod JSON Schema; v2 compares against a fresh
	// registry's first call instead, which shares no state with this one.
	expect(observe(build(fixture()), inputs)).toEqual(first)
	expect(observe(build(registry), inputs)).toEqual(first)
	expect(observe(build(registry), inputs)).toEqual(first)
})

test('compact options from every call carry compact metadata for the argument boundary', () => {
	const registry = fixture()
	for (let call = 0; call < 3; call++) {
		const schema = registry.tables.items.paginationOpts(
			{ title: true, target: { name: true } },
			{ validator: 'compact' },
		)
		const boundary = compactArgumentBoundary(schema.shape, () => schema.validator)
		expect(boundary).toBeDefined()
	}
})
