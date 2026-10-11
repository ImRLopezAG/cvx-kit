import { zid, zodToConvex } from 'convex-helpers/server/zod4'
import { defineSchema, defineTable, paginationOptsValidator } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { v } from 'convex/values'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'
import { z } from 'zod'

import { jsonSafeZid, tenantTable, zodTable } from '../src/zod-table'

const documents = zodTable(
	'documents',
	(id) => ({
		title: z.string(),
		ownerId: id('users'),
		secretNote: z.string(),
	}),
	{
		commandFields: ['title'],
		publicFields: ['title', 'ownerId'],
	},
)

describe('zodTable', () => {
	const row = {
		title: 'Quarterly report',
		ownerId: zid('users').parse('users:1'),
		secretNote: 'do not leak',
		_id: zid('documents').parse('documents:1'),
		_creationTime: 12,
	}

	it('adds only a validated id when explicitly requested', () => {
		const shorthand = documents.toPublicDto(row, true)
		expect(shorthand).toEqual({ title: row.title, ownerId: row.ownerId, _id: row._id })
		expect(documents.dto(true).parse(shorthand)).toEqual(shorthand)
		for (const options of [{ _id: true }] as const) {
			const dto = documents.toPublicDto(row, options)
			expect(dto).toEqual({ title: row.title, ownerId: row.ownerId, _id: row._id })
			expect(documents.dto(options).parse(dto)).toEqual(dto)
		}
		expect(documents.toPublicDto(row, false)).toEqual(documents.toPublicDto(row))
		for (const options of [{}, { _id: false }] as const) {
			expect(documents.toPublicDto(row, options)).toEqual(documents.toPublicDto(row))
		}
		expect(documents.dto()).toBe(documents.publicDto)
		expect(
			documents.publicDto.safeParse({ title: row.title, ownerId: row.ownerId, _id: row._id })
				.success,
		).toBe(false)
	})

	it('rejects missing or non-string ids only when requested', () => {
		const { _id, ...withoutId } = row
		void _id
		// @ts-expect-error requested IDs require an ID-bearing row
		expect(() => documents.toPublicDto(withoutId, true)).toThrow()
		// @ts-expect-error IDs must be strings
		expect(() => documents.toPublicDto({ ...row, _id: 42 }, { _id: true })).toThrow()
		expect(documents.toPublicDto(withoutId)).toEqual({ title: row.title, ownerId: row.ownerId })
	})

	it('validates extension values with the matching strict return schema', () => {
		const extend = {
			url: z.string().url(),
			length: z
				.number()
				.int()
				.refine((value) => value > 0),
		}
		const dto = documents.toPublicDto(row, {
			_id: true,
			extend,
			values: { url: 'https://example.com', length: 3 },
		})
		expect(dto).toEqual({
			title: row.title,
			ownerId: row.ownerId,
			_id: row._id,
			url: 'https://example.com',
			length: 3,
		})
		const result = documents.dto({ _id: true, extend })
		expect(result.parse(dto)).toEqual(dto)
		expect(result.safeParse({ ...dto, secretNote: 'leak' }).success).toBe(false)
		expect(() =>
			documents.toPublicDto(row, { extend, values: { url: 'invalid', length: 3 } }),
		).toThrow()
		// @ts-expect-error extension values are required
		expect(() => documents.toPublicDto(row, { extend })).toThrow()
		const values = { url: 'https://example.com', length: 3, title: 'overwrite' }
		expect(() => documents.toPublicDto(row, { extend, values })).toThrow()
		// @ts-expect-error extension values require an explicit schema
		expect(() => documents.toPublicDto(row, { values: { url: 'https://example.com' } })).toThrow()
	})

	it('rejects data-changing extension schemas before projecting or deriving a return schema', () => {
		const changing = z.string().transform((value) => value.length)
		const unsupported: z.ZodType[] = [
			changing,
			z.number().transform((value) => value + 1),
			z.string().pipe(z.string()),
			z.coerce.number(),
			z.preprocess((value) => value, z.string()),
			z.string().overwrite((value) => value.trim()),
			z.string().trim(),
			z.url({ normalize: true }),
			z.object({ nested: z.coerce.number() }).strict(),
			z.object({ nested: z.string().overwrite((value) => value + '!') }).strict(),
			z.string().default('filled'),
			z.string().catch('fallback'),
			z.custom<string>(),
			z.object({ nested: changing }),
			z.array(changing),
			changing.optional(),
			z.union([z.string(), changing]),
			z.record(z.string(), changing),
			z.tuple([changing]),
			z.object({ name: z.string() }).check(z.property('name', changing)),
		]
		for (const field of unsupported) {
			const extend = { extra: field }
			expect(() => documents.dto({ extend })).toThrow(/value-preserving/i)
			expect(() => documents.toPublicDto(row, { extend, values: { extra: 'abc' } })).toThrow(
				/value-preserving/i,
			)
		}
	})

	it('validates nested refinements and optionals against the actual projector output', () => {
		const extend = {
			extra: z
				.object({
					name: z
						.string()
						.min(1)
						.refine((value) => value !== 'hidden'),
					note: z.string().optional(),
				})
				.strict(),
		}
		const dto = documents.toPublicDto(row, { extend, values: { extra: { name: 'visible' } } })
		expect(documents.dto({ extend }).parse(dto)).toEqual(dto)
		expect(() =>
			documents.toPublicDto(row, { extend, values: { extra: { name: 'hidden' } } }),
		).toThrow()
	})

	it('rejects projected and reserved extension collisions at runtime', () => {
		for (const key of [
			'title',
			'ownerId',
			'_id',
			'_creationTime',
			'createdAt',
			'updatedAt',
			'archivedAt',
			'tenant',
			'__proto__',
		]) {
			const extend = { [key]: z.string() }
			expect(() => documents.dto({ extend })).toThrow(/collision/i)
			expect(() => documents.toPublicDto(row, { extend, values: { [key]: 'override' } })).toThrow(
				/collision/i,
			)
		}
	})

	it('preserves optional public and extension fields without spreading storage', () => {
		const notes = zodTable('notes', () => ({ text: z.string().optional(), secret: z.string() }), {
			publicFields: ['text'],
		})
		const extend = { url: z.string().optional() }
		const dto = notes.toPublicDto({ secret: 'hidden' }, { extend, values: {} })
		expect(dto).toEqual({ text: undefined })
		expect(notes.dto({ extend }).parse(dto)).toEqual(dto)
	})
	it('bakes opinionated timestamps into storage', () => {
		expect(Object.keys(documents.storage.shape).sort()).toEqual([
			'archivedAt',
			'createdAt',
			'ownerId',
			'secretNote',
			'title',
			'updatedAt',
		])
	})

	it('always removes timestamps from the insert boundary', () => {
		expect(Object.keys(documents.insertSchema.shape).sort()).toEqual([
			'ownerId',
			'secretNote',
			'title',
		])
	})

	it('allows exposing timestamps through publicFields explicitly', () => {
		const archive = zodTable('archive', () => ({ name: z.string() }), {
			publicFields: ['name', 'createdAt'],
		})
		expect(Object.keys(archive.publicDto.shape).sort()).toEqual(['createdAt', 'name'])
	})

	it('narrows the command boundary to the declared fields', () => {
		expect(Object.keys(documents.commandInput.shape)).toEqual(['title'])
		expect(() => documents.commandInput.parse({ title: 't', secretNote: 'x' })).toThrow()
	})

	it('redacts non-public fields at runtime through toPublicDto', () => {
		const dto = documents.toPublicDto({
			title: 'Quarterly report',
			ownerId: zid('users').parse('users:1'),
			secretNote: 'do not leak',
			createdAt: 1,
			updatedAt: 1,
		})
		expect(dto).toEqual({ title: 'Quarterly report', ownerId: 'users:1' })
		expect('secretNote' in dto).toBe(false)
	})

	it('derives update as a partial of insert and supports omit masks', () => {
		expect(documents.updateSchema.parse({})).toEqual({})
		const narrowed = documents.insert({ secretNote: true })
		expect(Object.keys(narrowed.shape).sort()).toEqual(['ownerId', 'title'])
	})

	it('exposes id and update tools bound to the table name', () => {
		expect(Object.keys(documents.tools.update.shape).sort()).toEqual(['data', 'id'])
		expect(documents.tableName).toBe('documents')
	})
})

describe('jsonSafeZid', () => {
	it('validates primitive ids while retaining the owning table type', () => {
		const schema = jsonSafeZid('documents')
		expect(schema.safeParse('').success).toBe(zid('documents').safeParse('').success)
		expect(schema.safeParse(42).success).toBe(false)
		expect(schema.parse('documents:1')).toBe('documents:1')
		expectTypeOf<z.output<typeof schema>>().toEqualTypeOf<
			import('convex/values').GenericId<'documents'>
		>()
		expect(z.toJSONSchema(schema)).toMatchObject({ type: 'string' })
	})
})

describe('U2 pagination and ownership', () => {
	const fields = () => ({
		name: z.string().transform((value) => value.length),
		count: z.number(),
		active: z.boolean(),
		status: z.enum(['open', 'done']),
		note: z.string().optional(),
		object: z.object({ nested: z.string() }),
		list: z.array(z.string()),
		owner: zid('users'),
	})
	const records = zodTable('records', fields, { serverFields: ['active'] })

	function innerFilters() {
		const pagination = records.paginationOpts({ count: true, owner: true })
		if (!(pagination instanceof z.ZodObject)) throw new Error('Expected pagination object')
		const inner = pagination.shape.filters.unwrap()
		if (!(inner instanceof z.ZodObject)) throw new Error('Expected filter object')
		return inner
	}

	it.each(['and', 'or', 'in'] as const)('preflights sparse %s array length', (key) => {
		const sparse: number[] = []
		sparse.length = 1000
		const filters = key === 'in' ? { count: { in: sparse } } : { [key]: sparse }
		const result = innerFilters().safeParse(filters)
		expect(result.success).toBe(false)
		expect(result.error?.issues).toHaveLength(1)
		expect(result.error?.issues[0].code).toBe('custom')
	})

	it.each(['inherited', 'nonenumerable', 'accessor'] as const)(
		'rejects unsupported %s layouts before reading children',
		(layout) => {
			let reads = 0
			const children = Array.from({ length: 200 }, () => ({ count: 1 }))
			const filters = layout === 'inherited' ? Object.create({ and: children }) : {}
			if (layout === 'nonenumerable') Object.defineProperty(filters, 'and', { value: children })
			if (layout === 'accessor') {
				Object.defineProperty(filters, 'and', {
					enumerable: true,
					get() {
						reads++
						return children
					},
				})
			}
			const result = innerFilters().safeParse(filters)
			expect(result.success).toBe(false)
			expect(result.error?.issues).toHaveLength(1)
			expect(reads).toBe(0)
		},
	)

	it.each(['clone', 'describe', 'refine'] as const)(
		'retains preflight through inner %s and outer composition',
		(method) => {
			const inner = innerFilters()
			const composed =
				method === 'clone'
					? inner.clone()
					: method === 'describe'
						? inner.describe('filters')
						: inner.refine(() => true)
			const filters = { and: Array.from({ length: 200 }, () => ({ count: 1 })) }
			const result = composed.safeParse(filters)
			expect(result.success).toBe(false)
			expect(result.error?.issues).toHaveLength(1)
			const outer = z
				.object({ filters: composed.optional() })
				.clone()
				.describe('options')
				.refine(() => true)
			expect(outer.safeParse({ filters }).success).toBe(false)
			expect(outer.parse({ filters: { count: { in: [1] } } })).toEqual({
				filters: { count: { in: [1] } },
			})
			const cycle = { not: {} }
			cycle.not = cycle
			expect(composed.safeParse(cycle).error?.issues).toHaveLength(1)
		},
	)

	it('checks nested layouts without invoking array or predicate accessors', () => {
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
		]) {
			expect(innerFilters().safeParse(filters).success).toBe(false)
		}
		expect(reads).toBe(0)
	})

	it('preserves native options and supports selected private/system fields', () => {
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
		const converted = zodToConvex(input)
		if (converted.kind !== 'object') throw new Error('Expected native object options')
		expect(converted.fields.endCursor).toEqual(paginationOptsValidator.fields.endCursor)
		expect(converted.fields.cursor).toEqual(paginationOptsValidator.fields.cursor)
	})

	it('rejects sizes, read limits, unknown options and malformed filters', () => {
		const input = records.paginationOpts({
			count: true,
			active: true,
			note: true,
			status: true,
			owner: true,
		})
		for (const numItems of [0, -1, 1.5, 101, Infinity, NaN])
			expect(input.safeParse({ numItems, cursor: null }).success).toBe(false)
		for (const key of ['maximumRowsRead', 'maximumBytesRead']) {
			for (const value of [0, -1, 1.5, Infinity])
				expect(input.safeParse({ numItems: 1, cursor: null, [key]: value }).success).toBe(false)
		}
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
			{ filters: { count: { in: [] } } },
			{ filters: { and: [] } },
		])
			expect(input.safeParse({ numItems: 1, cursor: null, ...extra }).success).toBe(false)
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

	it('rejects unknown, false and non-scalar selections at construction', () => {
		for (const selection of [
			{ missing: true },
			{ count: false },
			{ object: true },
			{ list: true },
		]) {
			// SAFETY: deliberate JS bypass exercises runtime selection guards.
			expect(() => records.paginationOpts(selection as never)).toThrow()
		}
	})

	it('bounds recursive validation before parsing nested predicates', () => {
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

	it('rejects reserved declarations and command/server collisions before injection', () => {
		for (const key of ['_id', '_creationTime', 'createdAt', 'updatedAt', 'archivedAt']) {
			expect(() => zodTable('invalid', () => ({ [key]: z.string() }))).toThrow(/reserved/i)
		}
		expect(() =>
			zodTable('invalid', () => ({ secret: z.string() }), {
				serverFields: ['secret'],
				// @ts-expect-error server-owned fields cannot enter commands
				commandFields: ['secret'],
			}),
		).toThrow()
		// @ts-expect-error tenant callback must not redeclare tenant
		expect(() => tenantTable('invalid', () => ({ tenant: z.string() }))).toThrow(/tenant/i)
		for (const options of [
			{ publicFields: ['missing'] },
			{ serverFields: ['missing'] },
			{ commandFields: ['missing'] },
			{ commandFields: ['createdAt'] },
			{ commandFields: ['tenant'] },
		]) {
			// SAFETY: deliberate JS bypass exercises field-list ownership checks.
			expect(() => tenantTable('invalid', () => ({ name: z.string() }), options as never)).toThrow()
		}
		const valid = tenantTable('valid', () => ({ name: z.string() }), {
			publicFields: ['tenant', 'createdAt'],
		})
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
})

describe('U2 native scalar metadata', () => {
	it('uses native literal/input kinds without invoking stored transformations', () => {
		const native = zodTable('native', (id) => ({
			owner: id('users').optional(),
			text: z.string().trim(),
			number: z.number().transform(() => 'changed'),
			literal: z.literal(2),
			big: z.bigint(),
			nil: z.null(),
			flag: z.literal(false),
			anything: z.any(),
		}))
		const schema = native.paginationOpts({
			owner: true,
			text: true,
			number: true,
			literal: true,
			big: true,
			nil: true,
			flag: true,
		})
		const filters = {
			owner: { eq: 'users:1', exists: true },
			text: ' untrimmed ',
			number: { gte: 3 },
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
		]) {
			expect(schema.safeParse({ numItems: 1, cursor: null, filters: invalid }).success).toBe(false)
		}
		// @ts-expect-error native any is not a supported scalar
		expect(() => native.paginationOpts({ anything: true })).toThrow()
	})
})

describe('U2 native ID-domain enforcement', () => {
	it.each(['original', 'clone', 'describe', 'refine'] as const)(
		'retains %s ID metadata and rejects wrong domains in every predicate branch',
		async (method) => {
			const boundary = zodTable('records', (id) => ({ owner: id('users').nullable() }))
			const original = boundary.paginationOpts({ owner: true })
			if (!(original instanceof z.ZodObject)) throw new Error('Expected pagination object')
			const inner = original.shape.filters.unwrap()
			const filters =
				method === 'clone'
					? inner.clone()
					: method === 'describe'
						? inner.describe('filters')
						: method === 'refine'
							? inner.refine(() => true)
							: inner
			const options = z
				.object({
					numItems: z.number(),
					cursor: z.string().nullable(),
					filters: filters.optional(),
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
					validate: base.query({ args: { options: zodToConvex(options) }, handler: () => true }),
				},
			})
			const t = app.createTest()
			const [owner, foreign] = await t.run(async (ctx) => [
				await ctx.db.insert('users', { name: 'u' }),
				await ctx.db.insert('other', { name: 'o' }),
			])
			for (const value of [foreign, 'not-an-id']) {
				for (const filters of [
					{ owner: value },
					{ owner: { eq: value } },
					{ owner: { in: [value] } },
					{ and: [{ not: { owner: { eq: value } } }] },
				]) {
					await expect(
						t.query(app.api.functions.validate, {
							options: { numItems: 1, cursor: null, filters },
						}),
					).rejects.toThrow()
				}
			}
			for (const filters of [
				{ owner },
				{ owner: { eq: owner } },
				{ owner: { in: [owner] } },
				{ or: [{ not: { owner } }] },
			]) {
				expect(
					await t.query(app.api.functions.validate, {
						options: { numItems: 1, cursor: null, filters },
					}),
				).toBe(true)
			}
		},
	)
})

it('supports nested native scalar unions such as nullable enums', () => {
	const nullable = zodTable('nullable', () => ({ status: z.enum(['open', 'done']).nullable() }))
	const options = nullable.paginationOpts({ status: true })
	expect(
		options.parse({ numItems: 1, cursor: null, filters: { status: { in: ['open', null] } } })
			.filters,
	).toEqual({ status: { in: ['open', null] } })
	expect(
		options.safeParse({ numItems: 1, cursor: null, filters: { status: { gt: 'open' } } }).success,
	).toBe(false)
})

it.each(['original', 'clone', 'describe', 'refine'] as const)(
	'accepts namespaced membership at the exact boolean depth boundary through %s',
	(method) => {
		const schema = documents.paginationOpts({ title: true })
		if (!(schema instanceof z.ZodObject)) throw new Error('Expected pagination object')
		const inner = schema.shape.filters.unwrap()
		const composed =
			method === 'clone'
				? inner.clone()
				: method === 'describe'
					? inner.describe('filters')
					: method === 'refine'
						? inner.refine(() => true)
						: inner
		type Nested = { title?: { in: string[] }; fields?: { title: { in: string[] } }; and?: Nested[] }
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

it('filters every scalar name through an unambiguous field namespace', () => {
	const logicalNames = zodTable('logicalNames', () => ({
		and: z.string(),
		or: z.number(),
		not: z.boolean(),
		fields: z.string(),
	}))
	const schema = logicalNames.paginationOpts({ and: true, or: true, not: true, fields: true })
	const filters = {
		fields: { and: 'a', or: { gt: 0 }, not: false, fields: 'f' },
		not: { fields: { not: true } },
	}
	expect(schema.parse({ numItems: 1, cursor: null, filters }).filters).toEqual(filters)
	expect(
		schema.safeParse({ numItems: 1, cursor: null, filters: { fields: { unknown: 'x' } } }).success,
	).toBe(false)
})
