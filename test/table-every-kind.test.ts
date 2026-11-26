import { describe, expect, it } from 'vite-plus/test'
import { k } from '../src/k'
import { kTable } from '../src/table'

const fields = {
	s: k.string().trim().min(1),
	n: k.number().finite().positive(),
	i: k.int().safe(),
	big: k.int64(),
	b: k.boolean(),
	nil: k.null(),
	bytes: k.bytes(),
	anything: k.any(),
	json: k.json(),
	jsonObject: k.jsonObject(),
	date: k.isoDate(),
	dateTime: k.isoDateTime(),
	ts: k.timestamp(),
	lit: k.literal('x'),
	en: k.enum(['a', 'b']),
	owner: k.id('users'),
	list: k.array(k.string().overwrite((value) => value)),
	nested: k.object({ a: k.string() }).strip(),
	loose: k.looseObject({ a: k.string() }),
	map: k.record(k.string(), k.number()),
	finite: k.record(k.enum(['x', 'y']), k.number()),
	partialMap: k.partialRecord(k.enum(['x', 'y']), k.number()),
	required: k.object({ a: k.string().optional() }).required(),
	either: k.union([k.string(), k.number()]),
	tagged: k.discriminatedUnion('kind', [
		k.object({ kind: k.literal('a'), a: k.string() }),
		k.object({ kind: k.literal('b') }),
	]),
	maybe: k.string().nullable().optional(),
	fallback: k.string().default('d'),
}

// SAFETY: Object.keys of the literal field map returns exactly its keys.
const keys = Object.keys(fields) as (keyof typeof fields)[]

const row = {
	s: 's',
	n: 1,
	i: 2,
	big: 3n,
	b: true,
	nil: null,
	bytes: new ArrayBuffer(1),
	anything: { any: 1 },
	json: [1, 'x'],
	jsonObject: { x: { y: [1] } },
	date: '2026-01-02',
	dateTime: '2026-01-02T00:00:00Z',
	ts: 5,
	lit: 'x' as const,
	en: 'a' as const,
	owner: 'users1',
	list: ['a'],
	nested: { a: 'a' },
	loose: { a: 'a' },
	map: { m: 1 },
	finite: { x: 1, y: 2 },
	partialMap: { x: 1 },
	required: { a: 'a' },
	either: 1,
	tagged: { kind: 'a' as const, a: 'a' },
	maybe: null,
	fallback: 'f',
}

describe('a table with one field of every kind', () => {
	const table = kTable('every', fields, { publicFields: keys })

	it('builds the native table', () => {
		const exported = table.table.validator.fields
		expect(Object.keys(exported)).toEqual([...keys, 'createdAt', 'updatedAt', 'archivedAt'])
		expect(exported.jsonObject.kind).toBe('any')
		expect(exported.finite.kind).toBe('object')
	})

	it('parses insert and update', () => {
		// SAFETY: the row matches the declared fields; `owner` is a string id.
		const parsed = table.insertSchema.parse(row as never)
		expect(parsed).toMatchObject({ s: 's', jsonObject: row.jsonObject, partialMap: { x: 1 } })
		expect(table.updateSchema.parse({ jsonObject: { a: 1 }, finite: { x: 1, y: 1 } })).toEqual({
			jsonObject: { a: 1 },
			finite: { x: 1, y: 1 },
		})
		expect(table.updateSchema.safeParse({ jsonObject: { $ref: 1 } }).success).toBe(false)
	})

	it('projects dto, publicDto and toPublicDto', () => {
		// SAFETY: as above.
		const dto = table.toPublicDto(row as never)
		expect(dto).toEqual(row)
		expect(table.dto().parse(dto)).toEqual(row)
		expect(table.publicDto.parse(dto)).toEqual(row)
		expect(() =>
			// SAFETY: a wrong stored value is the case under test.
			table.toPublicDto({ ...row, jsonObject: 1 } as never),
		).toThrow(/jsonObject/)
	})
})
