/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters -- Negative fixtures deliberately build cyclic, accessor-bearing and unsupported raw values. */
// `kTable(...).paginationOpts(...)`, `paginated(dto)` and the compact filter boundary on `k`
// registration, end to end in convex-test. This suite replaced the v1 compact-registration.test.ts and
// the pagination parts of zod-table.test.ts. Kit-raised failures carry the KTD6 payload
// `{ code: 'VALIDATION', issues }` where v1 raised `ZodError`.
import { NoOp } from 'convex-helpers/server/customFunctions'
import {
	actionGeneric,
	defineSchema,
	defineTable,
	makeFunctionReference,
	mutationGeneric,
	paginationOptsValidator,
	queryGeneric,
	type GenericDatabaseReader,
	type GenericDataModel,
} from 'convex/server'
import { ConvexError, v, type GenericValidator, type ValidatorJSON } from 'convex/values'
import { convexTest, defineTestApp } from 'convex-test'
import { describe, expect, test } from 'vite-plus/test'
import { k } from '../src/k'
import { compileFilters } from '../src/querying/filters'
import {
	relationFilterSchema,
	scalarPredicateFromSchema,
	type FilterGrammar,
} from '../src/querying/shared/filters'
import { kCustomAction, kCustomMutation, kCustomQuery } from '../src/registration'
import { kTable, paginated, tenantTable } from '../src/table'

const tasks = kTable(
	'tasks',
	{
		title: k.string(),
		status: k.enum(['open', 'done']),
		score: k.number(),
		count: k.int64().optional(),
		owner: k.id('users'),
	},
	{ publicFields: ['title', 'status', 'score'] },
)
const users = kTable('users', { name: k.string() })
const schema = defineSchema({
	tasks: tasks.table.index('by_status', ['status']),
	users: users.table,
})
const selection = { title: true, status: true, score: true, count: true, owner: true } as const
/** Without an ID field, the compact projection is `any` from depth 2 on. */
const scalars = { title: true, status: true, score: true, count: true } as const

function runtime(fn: { isConvexFunction: true }) {
	// SAFETY: native builder methods exist at runtime and intentionally accept hostile in-process inputs for these proofs.
	return fn as {
		isConvexFunction: true
		exportArgs(): string
		exportReturns(): string
		_handler(ctx: any, args: any): Promise<any>
	}
}

function nativeJson(validator: GenericValidator): ValidatorJSON {
	// SAFETY: Convex validators expose their registration JSON at runtime; declarations mark it internal.
	return (validator as GenericValidator & { readonly json: ValidatorJSON }).json
}

async function validationOf(run: Promise<unknown>) {
	try {
		await run
	} catch (error) {
		if (error instanceof ConvexError) return error.data
		throw error
	}
	throw new Error('expected a ConvexError')
}

const nested = (n: number, value: any): any => (n ? { not: nested(n - 1, value) } : value)

describe('kTable paginationOpts and paginated end to end', () => {
	const list = kCustomQuery(
		queryGeneric,
		NoOp,
	)({
		args: { paginationOpts: paginated(tasks.publicDto).args.paginationOpts },
		returns: paginated(tasks.publicDto).result,
		handler: async (ctx, args) => {
			// SAFETY: queryGeneric's context carries a database reader over this test's schema.
			const db = ctx.db as GenericDatabaseReader<GenericDataModel>
			const page = await db.query('tasks').order('asc').paginate(args.paginationOpts)
			// SAFETY: every stored tasks row carries the table's fields.
			return { ...page, page: page.page.map((row) => tasks.toPublicDto(row as never)) }
		},
	})
	const filtered = kCustomQuery(
		queryGeneric,
		NoOp,
	)({
		args: tasks.paginationOpts(selection),
		handler: async (ctx, args) => {
			// SAFETY: queryGeneric's context carries a database reader over this test's schema.
			const db = ctx.db as GenericDatabaseReader<GenericDataModel>
			const compiled = compileFilters(tasks.paginationOpts(selection), args, [
				{ name: 'by_status', fields: ['status', '_creationTime'] },
			])
			const rows = await db.query('tasks').collect()
			return {
				index: compiled.index?.name ?? null,
				titles: rows
					.filter((row) => row.status === compiled.bindings.get('status'))
					.map((row) => String(row.title)),
				order: args.order ?? null,
			}
		},
	})
	const compactNested = kCustomQuery(
		queryGeneric,
		NoOp,
	)({
		args: { page: tasks.paginationOpts(scalars, { validator: 'compact' }) },
		handler: (_ctx, args) => args.page.filters ?? null,
	})
	const t = () => {
		const harness = convexTest(schema, {
			'./functions.ts': async () => ({ list, filtered, compactNested }),
			'./_generated/server.ts': async () => ({ query: queryGeneric }),
		})
		return harness
	}

	test('paginated args and result validate a real page', async () => {
		const harness = t()
		const owner = await harness.run((ctx) => ctx.db.insert('users', { name: 'u' }))
		await harness.run(async (ctx) => {
			for (const [title, status] of [
				['a', 'open'],
				['b', 'done'],
				['c', 'open'],
			] as const)
				await ctx.db.insert('tasks', { title, status, score: 1, owner })
		})
		const ref = makeFunctionReference<'query'>('functions:list')
		const first = await harness.query(ref, { paginationOpts: { numItems: 2, cursor: null } })
		expect(first.page).toEqual([
			{ title: 'a', status: 'open', score: 1 },
			{ title: 'b', status: 'done', score: 1 },
		])
		expect(first.isDone).toBe(false)
		const second = await harness.query(ref, {
			paginationOpts: { numItems: 2, cursor: first.continueCursor },
		})
		expect(second.page).toEqual([{ title: 'c', status: 'open', score: 1 }])
		expect(JSON.parse(runtime(list).exportReturns()).value.page.fieldType.value).toMatchObject({
			type: 'object',
		})
		const page = paginated(tasks.publicDto)
		expect(nativeJson(page.args.paginationOpts.validator)).toEqual(
			JSON.parse(JSON.stringify(nativeJson(v.object(paginationOptsFields())))),
		)
		// Like v1's non-strict Zod objects, unknown keys are stripped on parse.
		expect(page.args.paginationOpts.parse({ numItems: 1, cursor: null, extra: 1 })).toEqual({
			numItems: 1,
			cursor: null,
		})
		expect(page.result.parse({ page: [], isDone: true, continueCursor: '', engine: 'x' })).toEqual({
			page: [],
			isDone: true,
			continueCursor: '',
		})
	})

	test('paginationOpts registers directly and its filters plan in the handler', async () => {
		const harness = t()
		const owner = await harness.run((ctx) => ctx.db.insert('users', { name: 'u' }))
		await harness.run(async (ctx) => {
			await ctx.db.insert('tasks', { title: 'a', status: 'open', score: 1, owner })
			await ctx.db.insert('tasks', { title: 'b', status: 'done', score: 2, owner })
		})
		const ref = makeFunctionReference<'query'>('functions:filtered')
		expect(
			await harness.query(ref, {
				numItems: 10,
				cursor: null,
				filters: { status: 'done', owner },
				order: 'desc',
			}),
		).toEqual({ index: 'by_status', titles: ['b'], order: 'desc' })
		// Convex validates the full structure natively; a structural miss never reaches the kit.
		await expect(
			harness.query(ref, { numItems: 10, cursor: null, filters: { unknown: 1 } }),
		).rejects.toThrow()
		// Bounds the native validator cannot express are kit checks, reported in the KTD6 shape.
		expect(await validationOf(harness.query(ref, { numItems: 101, cursor: null }))).toMatchObject({
			code: 'VALIDATION',
			issues: [{ path: ['numItems'], code: 'too_big' }],
		})
	})

	test('a compact boundary reports malformed and unknown filters at depth 2 with code VALIDATION', async () => {
		const harness = t()
		const ref = makeFunctionReference<'query'>('functions:compactNested')
		const page = (filters: unknown) => ({ page: { numItems: 1, cursor: null, filters } })
		expect(await harness.query(ref, page(nested(4, { title: 'x' })))).toEqual(
			nested(4, { title: 'x' }),
		)
		// Depth 2 is `any` to Convex, so these reach the kit, which walks them fully (KTD3).
		expect(await validationOf(harness.query(ref, page(nested(2, { title: 7 }))))).toEqual({
			code: 'VALIDATION',
			issues: [
				{
					path: ['page', 'filters', 'not', 'not', 'title'],
					code: 'invalid_union',
					message: expect.any(String),
				},
			],
		})
		expect(await validationOf(harness.query(ref, page(nested(2, { nope: 'x' }))))).toEqual({
			code: 'VALIDATION',
			issues: [
				{
					path: ['page', 'filters', 'not', 'not', 'nope'],
					code: 'unrecognized_key',
					message: expect.any(String),
				},
			],
		})
		expect(await validationOf(harness.query(ref, page(nested(5, {}))))).toEqual({
			code: 'VALIDATION',
			issues: [
				{
					path: ['page', 'filters'],
					code: 'custom',
					message: 'Unsupported filter layout or depth/node budget exceeded',
				},
			],
		})
		expect(runtime(compactNested).exportArgs().length * 2).toBeLessThan(
			runtime(
				kCustomQuery(
					queryGeneric,
					NoOp,
				)({
					args: { page: tasks.paginationOpts(scalars) },
					handler: () => null,
				}),
			).exportArgs().length,
		)
	})

	test('selection must name scalar document fields', () => {
		expect(() =>
			// SAFETY: untyped JS callers can name a field the selection type rejects.
			tasks.paginationOpts({ missing: true } as never),
		).toThrow('Invalid scalar filter selection "missing"')
		expect(Object.keys(tasks.paginationOpts({ _id: true, createdAt: true }).shape)).toEqual([
			'numItems',
			'cursor',
			'endCursor',
			'id',
			'maximumRowsRead',
			'maximumBytesRead',
			'onEmptyBudget',
			'filters',
			'order',
		])
	})
})

const grammar: FilterGrammar = {
	fields: { value: optional(scalarPredicateFromSchema(k.string(), true, false)) },
	relations: {},
}
function root() {
	return relationFilterSchema(grammar, undefined, { validator: 'compact' })
}

describe('paired compact registration boundary on k', () => {
	test('preflights before customization, with ordinary consumer hooks exactly once', async () => {
		const events: string[] = []
		const filters = root().refine(() => {
			events.push('refine')
			return true
		})
		const fn = kCustomQuery(queryGeneric, {
			args: {},
			input: () => {
				events.push('input')
				return {
					ctx: {},
					args: {},
					onSuccess: () => {
						events.push('success')
					},
				}
			},
		})({
			args: {
				filters: filters.optional(),
				other: k.string().overwrite((s) => {
					events.push('normalise')
					return s
				}),
			},
			handler: (_ctx, args) => {
				events.push('handler')
				return args.other.length
			},
		})
		const invalid = await validationOf(
			runtime(fn)._handler({}, { filters: nested(2, { value: 7 }), other: 'ok' }),
		)
		expect(invalid).toMatchObject({
			code: 'VALIDATION',
			issues: [{ path: ['filters', 'not', 'not', 'value'] }],
		})
		expect(events).toEqual([])
		expect(
			await runtime(fn)._handler({}, { filters: nested(4, { value: 'ok' }), other: 'ok' }),
		).toBe(2)
		expect(events).toEqual(['input', 'refine', 'normalise', 'handler', 'success'])
		events.length = 0
		expect(
			await runtime(fn)._handler(
				{},
				{ filters: nested(4, { value: 'different' }), other: 'second' },
			),
		).toBe(6)
		expect(events).toEqual(['input', 'refine', 'normalise', 'handler', 'success'])
	})

	test.each(['map', 'object', 'nested', 'optional'] as const)(
		'guards supported %s placement without invoking accessors',
		async (placement) => {
			const page = k.object({ filters: root().optional() })
			const args =
				placement === 'map'
					? page.shape
					: placement === 'object'
						? page
						: k.object({ page: placement === 'optional' ? page.optional() : page })
			let calls = 0
			const fn = kCustomQuery(queryGeneric, {
				args: {},
				input: () => {
					calls++
					return { ctx: {}, args: {} }
				},
			})({ args, handler: () => null })
			const bad = { filters: nested(2, { value: 8 }) }
			const wrap = (value: any) =>
				placement === 'map' || placement === 'object' ? value : { page: value }
			await expect(runtime(fn)._handler({}, wrap(bad))).rejects.toBeInstanceOf(ConvexError)
			let gets = 0
			const hostile = Object.defineProperty({}, 'filters', {
				enumerable: true,
				get() {
					gets++
					return {}
				},
			})
			await expect(runtime(fn)._handler({}, wrap(hostile))).rejects.toBeInstanceOf(ConvexError)
			expect(gets).toBe(0)
			expect(calls).toBe(0)
			if (placement === 'optional') await runtime(fn)._handler({}, {})
		},
	)

	test('rejects exact budget excesses and hostile layouts before customization or handlers', async () => {
		let calls = 0,
			gets = 0
		const fn = kCustomQuery(queryGeneric, {
			args: {},
			input: () => {
				calls++
				return { ctx: {}, args: {} }
			},
		})({
			args: { filters: root() },
			handler: () => {
				calls++
				return null
			},
		})
		const cycle: any = {}
		cycle.not = cycle
		const getter = Object.defineProperty({}, 'value', {
			enumerable: true,
			get() {
				gets++
				return 'oops'
			},
		})
		const inherited = Object.create({ value: 'oops' })
		const sparse: any[] = []
		sparse.length = 1
		const hostile = [
			nested(5, {}),
			{ and: Array(255).fill({}) },
			{ value: { in: Array(101).fill('x') } },
			nested(2, { unknown: 'x' }),
			nested(2, { value: {} }),
			cycle,
			getter,
			inherited,
			{ and: sparse },
			{ [Symbol('x')]: 1 },
			new Date(),
			Object.assign([], { extra: 1 }),
		]
		for (const filters of hostile) {
			const data = await validationOf(runtime(fn)._handler({}, { filters }))
			expect(data).toMatchObject({ code: 'VALIDATION' })
			expect(calls).toBe(0)
		}
		expect(gets).toBe(0)
		for (const filters of [
			nested(4, {}),
			{ and: Array(254).fill({}) },
			{ value: { in: Array(100).fill('x') } },
		])
			await runtime(fn)._handler({}, { filters })
		expect(calls).toBe(6)
	})

	test('leaves unsupported wrappers, defaults and skip mode on full conversion', async () => {
		const page = k.object({ filters: root().optional() })
		for (const args of [
			k.object({ pages: k.array(page) }),
			k.object({ page: page.nullable() }),
			k.object({ page: page.default({}) }),
		]) {
			const fn = kCustomQuery(queryGeneric, NoOp)({ args, handler: () => null })
			expect(runtime(fn).exportArgs()).toBe(JSON.stringify(nativeJson(args.validator)))
		}
		const events: string[] = []
		const fn = kCustomQuery(queryGeneric, {
			args: {},
			input: () => {
				events.push('input')
				return { ctx: {}, args: {} }
			},
		})({ args: page, skipConvexValidation: true, handler: () => null })
		expect(JSON.parse(runtime(fn).exportArgs())).toEqual({ type: 'any' })
		expect(
			await validationOf(runtime(fn)._handler({}, { filters: nested(2, { value: 7 }) })),
		).toMatchObject({ code: 'VALIDATION' })
		expect(events).toEqual(['input'])
	})

	test('guards native query mutation and action customization families', async () => {
		for (const [adapter, builder] of [
			[kCustomQuery, queryGeneric],
			[kCustomMutation, mutationGeneric],
			[kCustomAction, actionGeneric],
		] as const) {
			let calls = 0
			// SAFETY: the adapters share the private registration implementation; context is intentionally unused.
			const fn = (adapter as any)(builder, {
				args: {},
				input: () => {
					calls++
					return { ctx: {}, args: {} }
				},
			})({
				args: { filters: root() },
				handler: () => {
					calls++
					return null
				},
			})
			await expect(
				runtime(fn)._handler({}, { filters: nested(2, { value: 7 }) }),
			).rejects.toBeInstanceOf(ConvexError)
			expect(calls).toBe(0)
		}
	})

	test('rejects invalid relation/variant grammar before customization through describe and refine', async () => {
		const child: FilterGrammar = {
			fields: { value: optional(scalarPredicateFromSchema(k.enum(['a', 'b']), false, false)) },
			relations: {},
		}
		const generated = relationFilterSchema(
			{
				fields: child.fields,
				relations: {
					one: { cardinality: 'one', target: child },
					many: { cardinality: 'many', target: child },
				},
				variants: { discriminator: 'kind', options: { a: child, b: child } },
			},
			undefined,
			{ validator: 'compact' },
		)
		for (const filters of [
			generated,
			generated.describe('filters'),
			generated.refine(() => true),
		]) {
			let work = 0
			const args = k
				.object({ filters: filters.optional() })
				.extend({ other: k.string().optional() })
			const fn = kCustomQuery(queryGeneric, {
				args: {},
				input: () => {
					work++
					return { ctx: {}, args: {} }
				},
			})({
				args,
				handler: () => {
					work++
					return null
				},
			})
			for (const value of [
				{ not: { not: { variant: { tag: 'bad', filters: {} } } } },
				{ not: { not: { many: { some: {}, none: {} } } } },
				{ not: { not: { many: {} } } },
				{ not: { not: { value: 'bad' } } },
				{ not: { not: { value: { gt: 'a' } } } },
			]) {
				await expect(runtime(fn)._handler({}, { filters: value })).rejects.toBeInstanceOf(
					ConvexError,
				)
				expect(work).toBe(0)
			}
			await runtime(fn)._handler({}, { filters: { not: { one: { value: 'a' } } } })
			expect(work).toBe(2)
		}
	})

	test('does not run consumer rejection twice', async () => {
		let refinements = 0,
			inputs = 0,
			handlers = 0
		const filters = root().refine(() => {
			refinements++
			return false
		})
		const fn = kCustomQuery(queryGeneric, {
			args: {},
			input: () => {
				inputs++
				return { ctx: {}, args: {} }
			},
		})({
			args: { filters },
			handler: () => {
				handlers++
				return null
			},
		})
		expect(
			await validationOf(runtime(fn)._handler({}, { filters: { value: 'valid' } })),
		).toMatchObject({ code: 'VALIDATION', issues: [{ path: ['filters'], code: 'custom' }] })
		expect({ refinements, inputs, handlers }).toEqual({ refinements: 1, inputs: 1, handlers: 0 })
	})

	test('does not run a consumer transformation twice and exports it on full conversion', async () => {
		let transforms = 0
		const transformed = root().transform((value) => {
			transforms++
			return value
		})
		const fn = kCustomQuery(
			queryGeneric,
			NoOp,
		)({ args: { filters: transformed }, handler: () => null })
		expect(JSON.parse(runtime(fn).exportArgs()).value.filters.fieldType).toEqual(
			JSON.parse(JSON.stringify(nativeJson(root().validator))),
		)
		await runtime(fn)._handler({}, { filters: { value: 'valid' } })
		expect(transforms).toBe(1)
	})

	test('mixed native and k fields keep their native validators beside the projection', () => {
		const fn = kCustomQuery(
			queryGeneric,
			NoOp,
		)({
			args: { filters: root().optional(), tag: v.string() },
			handler: () => null,
		})
		const json = JSON.parse(runtime(fn).exportArgs())
		expect(json.value.tag).toEqual({ fieldType: { type: 'string' }, optional: false })
		expect(json.value.filters.fieldType.value.not.fieldType.value.not.fieldType).toEqual({
			type: 'any',
		})
	})
})

function optional(schema: ReturnType<typeof scalarPredicateFromSchema>) {
	// SAFETY: every KType at runtime is a k schema record with the chain methods.
	return (schema as ReturnType<typeof k.any>).optional()
}

function paginationOptsFields() {
	return {
		numItems: v.number(),
		cursor: v.union(v.string(), v.null()),
		endCursor: v.optional(v.union(v.string(), v.null())),
		id: v.optional(v.number()),
		maximumRowsRead: v.optional(v.number()),
		maximumBytesRead: v.optional(v.number()),
	}
}

// The table pagination boundary checks carried over from the v1 zod-table suite.
describe('kTable paginationOpts boundary', () => {
	const records = kTable(
		'records',
		{
			name: k.string(),
			count: k.number(),
			active: k.boolean(),
			status: k.enum(['open', 'done']),
			note: k.string().optional(),
			object: k.object({ nested: k.string() }),
			list: k.array(k.string()),
			owner: k.id('users'),
		},
		{ serverFields: ['active'] },
	)
	const innerFilters = () =>
		records.paginationOpts({ count: true, owner: true }).shape.filters.unwrap()

	test.each(['and', 'or', 'in'] as const)('preflights sparse %s array length', (key) => {
		const sparse: number[] = []
		sparse.length = 1000
		const result = innerFilters().safeParse(
			key === 'in' ? { count: { in: sparse } } : { [key]: sparse },
		)
		expect(result.success).toBe(false)
		if (!result.success) expect(result.issues).toHaveLength(1)
	})

	test.each(['inherited', 'nonenumerable', 'accessor'] as const)(
		'rejects unsupported %s layouts before reading children',
		(layout) => {
			let reads = 0
			const children = Array.from({ length: 200 }, () => ({ count: 1 }))
			const filters = layout === 'inherited' ? Object.create({ and: children }) : {}
			if (layout === 'nonenumerable') Object.defineProperty(filters, 'and', { value: children })
			if (layout === 'accessor')
				Object.defineProperty(filters, 'and', {
					enumerable: true,
					get() {
						reads++
						return children
					},
				})
			const result = innerFilters().safeParse(filters)
			expect(result.success).toBe(false)
			if (!result.success) expect(result.issues).toHaveLength(1)
			expect(reads).toBe(0)
		},
	)

	test.each(['describe', 'refine'] as const)(
		'retains preflight through inner %s and outer composition',
		(method) => {
			const inner = innerFilters()
			const composed = method === 'describe' ? inner.describe('filters') : inner.refine(() => true)
			const filters = { and: Array.from({ length: 200 }, () => ({ count: 1 })) }
			const result = composed.safeParse(filters)
			expect(result.success).toBe(false)
			if (!result.success) expect(result.issues).toHaveLength(1)
			const outer = k
				.object({ filters: composed.optional() })
				.describe('options')
				.refine(() => true)
			expect(outer.safeParse({ filters }).success).toBe(false)
			expect(outer.parse({ filters: { count: { in: [1] } } })).toEqual({
				filters: { count: { in: [1] } },
			})
			const cycle: { not: object } = { not: {} }
			cycle.not = cycle
			const cyclic = composed.safeParse(cycle)
			expect(cyclic.success).toBe(false)
			if (!cyclic.success) expect(cyclic.issues).toHaveLength(1)
		},
	)

	test('checks nested layouts without invoking array or predicate accessors', () => {
		let reads = 0
		const getter = {
			enumerable: true,
			get: () => {
				reads++
				return 1
			},
		}
		const accessorArray = [1]
		Object.defineProperty(accessorArray, '0', getter)
		for (const filters of [
			{ fields: Object.create({ count: 1 }) },
			{ count: Object.defineProperty({}, 'eq', { value: 1 }) },
			{ count: Object.defineProperty({}, 'eq', getter) },
			{ count: { in: accessorArray } },
		])
			expect(innerFilters().safeParse(filters).success).toBe(false)
		expect(reads).toBe(0)
	})

	test('preserves native options and supports selected private and system fields', () => {
		const input = records.paginationOpts({
			name: true,
			active: true,
			owner: true,
			_id: true,
			_creationTime: true,
		})
		const native = {
			numItems: 100,
			cursor: null,
			endCursor: 'end',
			maximumRowsRead: 200,
			maximumBytesRead: 1000,
		}
		expect(input.parse(native)).toEqual(native)
		const args = {
			...native,
			order: 'desc',
			filters: {
				name: { gte: 'a' },
				active: false,
				owner: { in: ['users:1'] },
				_creationTime: { gt: 0 },
			},
		}
		expect(input.parse(args)).toEqual(args)
		const converted = input.validator
		expect(converted.fields.endCursor).toEqual(paginationOptsValidator.fields.endCursor)
		expect(converted.fields.cursor).toEqual(paginationOptsValidator.fields.cursor)
	})

	test('rejects sizes, read limits, unknown options and malformed filters', () => {
		const input = records.paginationOpts({
			count: true,
			active: true,
			note: true,
			status: true,
			owner: true,
		})
		for (const numItems of [0, -1, 1.5, 101, Infinity, NaN])
			expect(input.safeParse({ numItems, cursor: null }).success).toBe(false)
		for (const key of ['maximumRowsRead', 'maximumBytesRead'])
			for (const value of [0, -1, 1.5, Infinity])
				expect(input.safeParse({ numItems: 1, cursor: null, [key]: value }).success).toBe(false)
		for (const extra of [
			{ order: 'sideways' },
			{ extra: 1 },
			{ filters: { name: 'x' } },
			{ filters: { count: '1' } },
			{ filters: { count: { eq: '1' } } },
			{ filters: { active: { gt: true } } },
			{ filters: { status: { eq: 'missing' } } },
			{ filters: { owner: { lt: 'users:1' } } },
			{ filters: { count: { exists: false } } },
			{ filters: { count: { nope: 1 } } },
			{ filters: { count: {} } },
			{ filters: { and: [] } },
		])
			expect(
				input.safeParse({ numItems: 1, cursor: null, ...extra }).success,
				JSON.stringify(extra),
			).toBe(false)
		// The empty membership set is admitted; execution returns no rows.
		expect(
			input.parse({ numItems: 1, cursor: null, filters: { count: { in: [] } } }).filters,
		).toEqual({
			count: { in: [] },
		})
		expect(
			input.parse({
				numItems: 1,
				cursor: null,
				filters: {
					and: [{ count: { gte: 1, lt: 9 } }, { not: { active: true } }],
					note: { exists: false },
				},
			}).filters,
		).toBeDefined()
	})

	test('rejects false and non-scalar selections at construction', () => {
		for (const selection of [{ count: false }, { object: true }, { list: true }])
			// SAFETY: deliberate JS bypass exercises runtime selection guards.
			expect(() => records.paginationOpts(selection as never)).toThrow()
	})

	test('bounds recursive validation before parsing nested predicates', () => {
		const input = records.paginationOpts({ count: true })
		type NestedFilter = { count?: { eq: number }; not?: NestedFilter }
		let filters: NestedFilter = { count: { eq: 1 } }
		for (let i = 0; i < 100; i++) filters = { not: filters }
		expect(input.safeParse({ numItems: 1, cursor: null, filters }).success).toBe(false)
		const cycle: NestedFilter = {}
		cycle.not = cycle
		expect(input.safeParse({ numItems: 1, cursor: null, filters: cycle }).success).toBe(false)
		expect(
			input.safeParse({
				numItems: 1,
				cursor: null,
				filters: { count: { in: Array.from({ length: 1000 }, () => 1) } },
			}).success,
		).toBe(false)
	})

	test('a tenant table filters on its public tenant and timestamps', () => {
		const valid = tenantTable(
			'valid',
			{ name: k.string() },
			{ publicFields: ['tenant', 'createdAt'] },
		)
		expect(valid.publicDto.parse({ tenant: 't', createdAt: 1 })).toEqual({
			tenant: 't',
			createdAt: 1,
		})
		expect(valid.commandInput.parse({})).toEqual({})
		expect(
			valid
				.paginationOpts({ tenant: true, createdAt: true })
				.parse({ numItems: 1, cursor: null, filters: { tenant: 't', createdAt: { exists: true } } })
				.filters,
		).toBeDefined()
	})

	test('uses native literal and input kinds for scalar predicates', () => {
		const native = kTable('native', {
			owner: k.id('users').optional(),
			text: k.string().trim(),
			literal: k.literal(2),
			big: k.int64(),
			nil: k.null(),
			flag: k.literal(false),
			anything: k.any(),
		})
		const schema = native.paginationOpts({
			owner: true,
			text: true,
			literal: true,
			big: true,
			nil: true,
			flag: true,
		})
		const filters = {
			owner: { eq: 'users:1', exists: true },
			text: ' untrimmed ',
			literal: { lt: 2, in: [2] },
			big: { gt: 2n },
			nil: null,
			flag: false,
		}
		expect(schema.parse({ numItems: 1, cursor: null, filters }).filters).toEqual(filters)
		for (const invalid of [
			{ literal: { eq: 3 } },
			{ literal: { gt: '2' } },
			{ big: 2 },
			{ flag: { gt: false } },
			{ nil: 'null' },
		])
			expect(schema.safeParse({ numItems: 1, cursor: null, filters: invalid }).success).toBe(false)
		// @ts-expect-error native any is not a supported scalar
		expect(() => native.paginationOpts({ anything: true })).toThrow()
	})

	test.each(['original', 'describe', 'refine'] as const)(
		'retains %s id metadata and rejects wrong domains in every predicate branch',
		async (method) => {
			const boundary = kTable('records', { owner: k.id('users').nullable() })
			const inner = boundary.paginationOpts({ owner: true }).shape.filters.unwrap()
			const filtersSchema =
				method === 'describe'
					? inner.describe('filters')
					: method === 'refine'
						? inner.refine(() => true)
						: inner
			const options = k
				.object({
					numItems: k.number(),
					cursor: k.string().nullable(),
					filters: filtersSchema.optional(),
				})
				.describe('options')
				.refine(() => true)
			const base = defineTestApp({
				schema: defineSchema({
					users: defineTable({ name: v.string() }),
					other: defineTable({ name: v.string() }),
				}),
			})
			const app = base.defineModules({
				functions: {
					validate: base.query({ args: { options: options.validator }, handler: () => true }),
				},
			})
			const t = app.createTest()
			const [owner, foreign] = await t.run(async (ctx) => [
				await ctx.db.insert('users', { name: 'u' }),
				await ctx.db.insert('other', { name: 'o' }),
			])
			for (const value of [foreign, 'not-an-id'])
				for (const filters of [
					{ owner: value },
					{ owner: { eq: value } },
					{ owner: { in: [value] } },
					{ and: [{ not: { owner: { eq: value } } }] },
				])
					await expect(
						t.query(app.api.functions.validate, {
							// SAFETY: deliberately send malformed and foreign ids to exercise native validation.
							options: { numItems: 1, cursor: null, filters } as never,
						}),
					).rejects.toThrow()
			for (const filters of [
				{ owner },
				{ owner: { eq: owner } },
				{ owner: { in: [owner] } },
				{ or: [{ not: { owner } }] },
			])
				expect(
					await t.query(app.api.functions.validate, {
						options: { numItems: 1, cursor: null, filters },
					}),
				).toBe(true)
		},
	)

	test('supports nested native scalar unions such as nullable enums', () => {
		const nullable = kTable('nullable', { status: k.enum(['open', 'done']).nullable() })
		const options = nullable.paginationOpts({ status: true })
		expect(
			options.parse({ numItems: 1, cursor: null, filters: { status: { in: ['open', null] } } })
				.filters,
		).toEqual({ status: { in: ['open', null] } })
		expect(
			options.safeParse({ numItems: 1, cursor: null, filters: { status: { gt: 'open' } } }).success,
		).toBe(false)
	})

	test.each(['original', 'describe', 'refine'] as const)(
		'accepts namespaced membership at the exact boolean depth boundary through %s',
		(method) => {
			const inner = tasks.paginationOpts({ title: true }).shape.filters.unwrap()
			const composed =
				method === 'describe'
					? inner.describe('filters')
					: method === 'refine'
						? inner.refine(() => true)
						: inner
			type Nested = {
				title?: { in: string[] }
				fields?: { title: { in: string[] } }
				and?: Nested[]
			}
			let filters: Nested = { fields: { title: { in: ['x'] } } }
			let direct: Nested = { title: { in: ['x'] } }
			for (let depth = 0; depth < 4; depth++) {
				filters = { and: [filters] }
				direct = { and: [direct] }
			}
			expect(composed.parse(filters)).toEqual(filters)
			expect(composed.parse(direct)).toEqual(direct)
			expect(composed.safeParse({ and: [filters] }).success).toBe(false)
		},
	)

	test('filters every scalar name through an unambiguous field namespace', () => {
		const logicalNames = kTable('logicalNames', {
			and: k.string(),
			or: k.number(),
			not: k.boolean(),
			fields: k.string(),
		})
		const schema = logicalNames.paginationOpts({ and: true, or: true, not: true, fields: true })
		const filters = {
			fields: { and: 'a', or: { gt: 0 }, not: false, fields: 'f' },
			not: { fields: { not: true } },
		}
		expect(schema.parse({ numItems: 1, cursor: null, filters }).filters).toEqual(filters)
		expect(
			schema.safeParse({ numItems: 1, cursor: null, filters: { fields: { unknown: 'x' } } })
				.success,
		).toBe(false)
	})
})
