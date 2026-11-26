import { queryGeneric } from 'convex/server'
import { NoOp } from 'convex-helpers/server/customFunctions'
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import { z } from 'zod'
import type { GenericValidator, ValidatorJSON } from 'convex/values'

// Every filter predicate and filter boundary relations builds goes through these.
const built = vi.hoisted(() => ({ predicates: 0, filters: 0, rows: 0 }))
vi.mock('../src/querying/filters', async (load) => {
	const actual = await load<typeof import('../src/querying/filters')>()
	return {
		...actual,
		scalarPredicateSchema: ((validator) => {
			built.predicates++
			return actual.scalarPredicateSchema(validator)
		}) satisfies typeof actual.scalarPredicateSchema,
		relationFilterSchema: ((...input) => {
			built.filters++
			return actual.relationFilterSchema(...input)
		}) satisfies typeof actual.relationFilterSchema,
	}
})
// Row validators restore each table DTO from its recipe; pagination args restore
// the native pagination fields.
vi.mock('../src/querying/schema-snapshot', async (load) => {
	const actual = await load<typeof import('../src/querying/schema-snapshot')>()
	return {
		...actual,
		materializeDto: ((recipe) => {
			built.rows++
			return actual.materializeDto(recipe)
		}) satisfies typeof actual.materializeDto,
	}
})

const { defineRelations } = await import('../src/relations')
const { zid, zodTable, zodVariantTable } = await import('../src/zod-table')
const { zodToConvex } = await import('../src/zod-convex')
const { zCustomQuery } = await import('../src/zod-registration')
const { compactArgumentBoundary } = await import('../src/querying/filter-boundary')
const { lazyOptional } = await import('../src/querying/shared/lazy')

function fixture() {
	const target = zodTable('target', () => ({ name: z.string(), rank: z.number() }), {
		publicFields: ['name', 'rank'],
	})
	const items = zodTable(
		'items',
		() => ({
			title: z.string(),
			count: z.number(),
			tags: z.array(z.string()),
			targetId: zid('target'),
		}),
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
	const registry = defineRelations({ source, target, items }, (r) => ({
		items: { target: r.one.target({ from: r.items.targetId, to: r.target._id }) },
		source: { target: r.one.target({ from: r.source.targetId, to: r.target._id }) },
	}))
	// First use of each table materializes it; count only what helpers build.
	for (const table of ['items', 'source', 'target'] as const)
		registry.tables[table].pageDto({}).safeParse(null)
	return registry
}

function json(validator: GenericValidator): ValidatorJSON {
	// SAFETY: Convex exposes converter JSON at runtime but omits it from public declarations.
	return (validator as GenericValidator & { json: ValidatorJSON }).json
}
function object(schema: z.ZodType): z.ZodObject {
	if (!(schema instanceof z.ZodObject)) throw new Error('Expected object schema')
	return schema
}
const reset = () => Object.assign(built, { predicates: 0, filters: 0, rows: 0 })
const query = zCustomQuery(queryGeneric, NoOp)
interface Exported {
	exportArgs(): string
	exportReturns(): string
}
function exported(fn: { isConvexFunction: true }) {
	// SAFETY: native builders attach these export thunks at runtime; the public type strips them.
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The export thunks are absent from the public type.
	return fn as unknown as Exported
}
/** Selections the helper types reject, to reach their runtime checks. */
interface RawSelection {
	readonly [field: string]: RawSelection | boolean
}
type Unchecked = (selection: RawSelection) => z.ZodType
function unchecked(helper: Function): Unchecked {
	// SAFETY: every helper accepts a selection first; these tests assert its runtime rejections.
	return helper as Unchecked
}

describe('paginationOpts builds its filters on first use', () => {
	beforeEach(reset)

	test('declaring, composing and registering build nothing; export builds once', () => {
		const registry = fixture()
		reset()
		const options = registry.tables.items.paginationOpts(
			{ title: true, target: { name: true } },
			{ validator: 'compact' },
		)
		// Accord's consumer forms: pick + extend, a copied shape, and data args.
		const composed = object(options)
			.pick({ filters: true, order: true })
			.extend({ paginationOpts: z.object({ numItems: z.number(), cursor: z.string().nullable() }) })
		const copied = z.object({ ...object(options).shape })
		const fn = query({ args: composed, handler: () => null })
		expect(object(options).shape.filters).toBeInstanceOf(z.ZodOptional)
		// Only the shared native pagination fields are restored at the call.
		expect(built).toEqual({ predicates: 0, filters: 0, rows: 1 })

		const pushed = exported(fn).exportArgs()
		expect(built.filters).toBe(1)
		expect(built.predicates).toBeGreaterThan(0)
		const predicates = built.predicates
		// The original, the composed copy and the copied shape share the one build.
		expect(options.safeParse({ numItems: 1, cursor: null, filters: { title: 'x' } }).success).toBe(
			true,
		)
		expect(copied.safeParse({ numItems: 1, cursor: null, filters: { title: 1 } }).success).toBe(
			false,
		)
		expect(json(zodToConvex(options))).toEqual(json(zodToConvex(copied)))
		expect(built).toMatchObject({ filters: 1, predicates })
		expect(compactArgumentBoundary(composed)).toBeDefined()

		// Building first or last makes no difference to what Convex receives.
		const forcedFirst = registry.tables.items.paginationOpts(
			{ title: true, target: { name: true } },
			{ validator: 'compact' },
		)
		void object(forcedFirst).shape.filters.unwrap()
		const again = query({
			args: object(forcedFirst)
				.pick({ filters: true, order: true })
				.extend({
					paginationOpts: z.object({ numItems: z.number(), cursor: z.string().nullable() }),
				}),
			handler: () => null,
		})
		expect(exported(again).exportArgs()).toBe(pushed)
	})

	test('a request builds only the selection it uses', () => {
		const registry = fixture()
		reset()
		const used = registry.tables.items.paginationOpts({ title: true })
		registry.tables.items.paginationOpts({ count: true, target: { name: true, rank: true } })
		registry.tables.source.paginationOpts({ variants: { a: { amount: true } } })
		expect(built.filters).toBe(0)
		expect(used.safeParse({ numItems: 1, cursor: null, filters: { title: 'x' } }).success).toBe(
			true,
		)
		expect(built).toMatchObject({ filters: 1, predicates: 1 })
	})

	test('selection errors still throw at the call, before anything is built', () => {
		const registry = fixture()
		reset()
		const items = unchecked(registry.tables.items.paginationOpts)
		expect(() => items({ missing: true })).toThrow(
			'Invalid relation filter selection "items.missing"',
		)
		expect(() => items({ tags: true })).toThrow('Unsupported scalar filter kind "array"')
		expect(() => items({ target: { missing: true } })).toThrow(
			'Invalid relation filter selection "target.missing"',
		)
		const variants = unchecked(registry.tables.source.paginationOpts)
		expect(() => variants({ variants: { c: { amount: true } } })).toThrow(
			'Unknown variant filter selection',
		)
		expect(() => items({ title: false })).toThrow('Invalid selection')
		expect(built).toEqual({ predicates: 0, filters: 0, rows: 0 })
	})

	test('the selection and options are captured at the call', () => {
		const registry = fixture()
		const selection = { title: true } as const
		const options = { validator: 'compact' } as const
		const schema = registry.tables.items.paginationOpts(selection, { ...options })
		const plain = registry.tables.items.paginationOpts(selection, options)
		// Mutate both after the call, behind the readonly types.
		Reflect.set(selection, 'count', true)
		Reflect.deleteProperty(options, 'validator')
		for (const result of [schema, plain]) {
			expect(result.safeParse({ numItems: 1, cursor: null, filters: { count: 1 } }).success).toBe(
				false,
			)
			expect(result.safeParse({ numItems: 1, cursor: null, filters: { title: 'x' } }).success).toBe(
				true,
			)
			expect(compactArgumentBoundary(object(result))).toBeDefined()
		}
	})
})

describe('pageDto builds its row validator on first use', () => {
	beforeEach(reset)

	test('declaring and registering build no row; export builds it once', () => {
		const registry = fixture()
		reset()
		const page = registry.tables.source.pageDto({ target: true })
		const fn = query({ args: {}, returns: page, handler: () => null })
		expect(built.rows).toBe(0)
		exported(fn).exportReturns()
		const rows = built.rows
		expect(rows).toBeGreaterThan(0)
		const value = {
			page: [{ _id: 'source:1', kind: 'a', amount: 1, targetId: 'target:1', target: null }],
			isDone: true,
			continueCursor: '',
		}
		expect(page.parse(value)).toEqual(value)
		expect(built.rows).toBe(rows)
	})

	test('selection errors still fail at the call (target materialization: relations-preflight-lazy)', () => {
		const registry = fixture()
		const items = unchecked(registry.tables.items.pageDto)
		expect(() => items({ missing: true })).toThrow('Unknown or too deep relation "items.missing"')
		expect(() => items({ target: { missing: true } })).toThrow(
			'Unknown or too deep relation "target.missing"',
		)
	})

	test('every call still returns an independent graph', () => {
		const registry = fixture()
		const first = object(registry.tables.items.pageDto({}))
		const second = object(registry.tables.items.pageDto({}))
		const row = (schema: z.ZodObject) => {
			const page = schema.shape.page
			if (!(page instanceof z.ZodArray) || !(page.element instanceof z.ZodObject))
				throw new Error('Expected row')
			return page.element
		}
		expect(row(first)).not.toBe(row(second))
		row(first).shape.title = z.number()
		const value = {
			page: [{ _id: 'items:1', title: 't', count: 1, targetId: 'target:1' }],
			isDone: true,
			continueCursor: '',
		}
		expect(first.safeParse(value).success).toBe(false)
		expect(second.parse(value)).toEqual(value)
	})
})

describe('lazyOptional', () => {
	test('matches an eager optional for parsing, Convex and JSON Schema', () => {
		let builds = 0
		const inner = () => {
			builds++
			return z.strictObject({ name: z.string().min(1) })
		}
		const lazy = lazyOptional(inner)
		const eager = inner().optional()
		builds = 0
		const described = lazy.describe('described')
		const wrapped = z.object({ value: lazy }).pick({ value: true })
		expect(builds).toBe(0)
		expect(json(zodToConvex(lazy))).toEqual(json(zodToConvex(eager)))
		expect(z.toJSONSchema(lazy)).toEqual(z.toJSONSchema(eager))
		expect(lazy.unwrap()).toBe(described.unwrap())
		for (const input of [undefined, { name: 'x' }, { name: '' }, { name: 'x', extra: 1 }, null])
			expect(lazy.safeParse(input).success).toBe(eager.safeParse(input).success)
		expect(wrapped.safeParse({ value: { name: '' } }).success).toBe(false)
		expect(builds).toBe(1)
	})

	test('a failed build rethrows on every use', () => {
		const lazy = lazyOptional((): z.ZodString => {
			throw new Error('broken')
		})
		expect(() => lazy.parse('x')).toThrow('broken')
		expect(() => lazy.unwrap()).toThrow('broken')
	})
})
