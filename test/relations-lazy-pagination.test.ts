import { queryGeneric } from 'convex/server'
import { v } from 'convex/values'
import { relationFilterSchema } from '../src/querying/shared/filters'
import { NoOp } from 'convex-helpers/server/customFunctions'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'
import { k, type KSchema, type KType } from '../src/k'
import { kCustomQuery } from '../src/registration'
import { kTable } from '../src/table'

const built = vi.hoisted(() => ({ predicates: 0 }))
vi.mock('../src/querying/filters', async (load) => {
	const actual = await load<typeof import('../src/querying/filters')>()
	return {
		...actual,
		scalarPredicateSchema: ((validator) => {
			built.predicates++
			return actual.scalarPredicateSchema(validator)
		}) satisfies typeof actual.scalarPredicateSchema,
	}
})
const { defineRelations } = await import('../src/relations')

function fixture() {
	const target = kTable('target', { name: k.string(), rank: k.number() })
	const items = kTable('items', {
		title: k.string(),
		count: k.number(),
		tags: k.array(k.string()),
		targetId: k.id('target'),
	})
	const registry = defineRelations({ items, target }, (r) => ({
		items: { target: r.one.target({ from: r.items.targetId, to: r.target._id }) },
	}))
	// Isolate pagination construction from each table's first materialisation.
	registry.tables.items.paginationOpts({})
	registry.tables.target.paginationOpts({})
	built.predicates = 0
	return registry
}

function schema(node: KType): KSchema {
	// SAFETY: paginationOpts returns the KObject built by its implementation.
	return node as KSchema
}

const query = kCustomQuery(queryGeneric, NoOp)
function exported(fn: { isConvexFunction: true }) {
	// SAFETY: Convex attaches validator export methods to each registered function.
	return fn as typeof fn & { exportArgs(): string }
}

describe('relation pagination builds operator schemas on first use', () => {
	afterEach(() => vi.restoreAllMocks())
	test.each([undefined, 'compact'] as const)(
		'defers independent declarations (%s)',
		(validator) => {
			const registry = fixture()
			const nativeObjects = vi.spyOn(v, 'object')
			const settings = validator === undefined ? undefined : { validator }
			const first = registry.tables.items.paginationOpts(
				{ title: true, target: { name: true } },
				settings,
			)
			const second = registry.tables.items.paginationOpts(
				{ count: true, target: { rank: true } },
				settings,
			)
			const third = registry.tables.items.paginationOpts({ title: true }, settings)
			const one = query({ args: { paginationOpts: first }, handler: () => null })
			const two = query({ args: { paginationOpts: second }, handler: () => null })
			expect(built.predicates).toBe(0)
			expect(nativeObjects).not.toHaveBeenCalled()
			exported(one).exportArgs()
			expect(built.predicates).toBe(2)
			const firstObjects = nativeObjects.mock.calls.length
			expect(firstObjects).toBeGreaterThan(0)
			exported(one).exportArgs()
			expect(built.predicates).toBe(2)
			expect(nativeObjects).toHaveBeenCalledTimes(firstObjects)
			exported(two).exportArgs()
			expect(built.predicates).toBe(4)
			expect(nativeObjects.mock.calls.length).toBeGreaterThan(firstObjects)
			expect(
				schema(third).safeParse({ cursor: null, numItems: 10, filters: { title: { eq: 'a' } } })
					.success,
			).toBe(true)
			expect(built.predicates).toBe(5)
		},
	)

	test('keeps selection errors eager and in declaration order', () => {
		const registry = fixture()
		// SAFETY: invalid selections deliberately bypass the public selection-key constraint.
		const options = registry.tables.items.paginationOpts as (
			selection: Record<string, true>,
		) => KType
		expect(() => options({ tags: true, missing: true })).toThrow(
			'Unsupported scalar filter kind "array"',
		)
		expect(() => options({ missing: true, tags: true })).toThrow(
			'Invalid relation filter selection "items.missing"',
		)
		expect(built.predicates).toBe(0)
	})
	test('compact capture snapshots caller-owned field getters eagerly', () => {
		let reads = 0
		let field: KType = k.string()
		const fields = {
			get title() {
				reads++
				return field
			},
		}
		const filters = relationFilterSchema({ fields, relations: {} }, undefined, {
			validator: 'compact',
		})
		expect(reads).toBe(1)
		field = k.number()
		expect(schema(filters).safeParse({ title: 'kept' }).success).toBe(true)
		expect(schema(filters).safeParse({ title: 1 }).success).toBe(false)
		expect(reads).toBe(1)
	})
})
