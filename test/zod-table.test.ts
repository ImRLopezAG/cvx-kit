import { zid } from 'convex-helpers/server/zod4'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'
import { z } from 'zod'

import { jsonSafeZid, zodTable } from '../src/zod-table'

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
