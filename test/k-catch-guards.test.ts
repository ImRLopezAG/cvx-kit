import { describe, expect, it } from 'vite-plus/test'
import { toJsonSchema } from '../src/json-schema'
import { k } from '../src/k'
import { runDeclared } from '../src/k/parse'
import { kTable, kVariantTable } from '../src/table'

describe('catch around ids', () => {
	it('rejects k.id directly, with the reason and the remedy', () => {
		// @ts-expect-error -- `catch` on an id is a type error; the runtime guard is what is tested.
		expect(() => k.id('users').catch('fallback')).toThrow(
			/an id's table can only be checked by Convex/,
		)
		// @ts-expect-error -- as above.
		expect(() => k.id('users').catch('fallback')).toThrow(/ctx\.db\.normalizeId/)
	})

	it('rejects an id at any depth, naming the path', () => {
		// SAFETY: a fallback of the wrong shape is fine; the declaration throws before it is used.
		expect(() => k.object({ a: k.string(), owner: k.id('users') }).catch({} as never)).toThrow(
			/at 'owner'/,
		)
		expect(() => k.array(k.object({ ids: k.array(k.id('users')) })).catch([])).toThrow(
			/at '\[\]\.ids\[\]'/,
		)
		expect(() => k.record(k.string(), k.id('users').optional()).catch({})).toThrow(/\[value\]/)
		expect(() => k.record(k.id('users'), k.string()).catch({})).toThrow(/\[key\]/)
		expect(() => k.union([k.string(), k.id('users')]).catch('x')).toThrow(/\|1/)
		// SAFETY: a fallback of the wrong shape is fine; the declaration throws before it is used.
		expect(() =>
			k
				.discriminatedUnion('kind', [k.object({ kind: k.literal('a'), id: k.id('users') })])
				.catch({ kind: 'a' } as never),
		).toThrow(/\|0\.id/)
		// SAFETY: a fallback of the wrong shape is fine; the declaration throws before it is used.
		expect(() => k.string().pipe(k.id('users')).catch('x' as never)).toThrow(/k\.id/)
		// SAFETY: a fallback of the wrong shape is fine; the declaration throws before it is used.
		expect(() => k.id('users').nullable().optional().describe('x').catch(null as never)).toThrow()
	})

	it('allows catch beside an id', () => {
		const schema = k.object({ owner: k.id('users'), role: k.enum(['a', 'b']).catch('a') })
		expect(schema.parse({ owner: 'u1', role: 'zzz' })).toEqual({ owner: 'u1', role: 'a' })
		expect(schema.validator.fields.owner.kind).toBe('id')
	})
})

describe('catch in variant tables and DTO extensions', () => {
	const options = { discriminator: 'kind', variants: { a: {} } } as const
	it('rejects a caught branch field', () => {
		expect(() =>
			kVariantTable(
				't',
				k.discriminatedUnion('kind', [
					k.object({ kind: k.literal('a'), role: k.enum(['member', 'admin']).catch('member') }),
				]),
				// SAFETY: the runtime guard is tested; the typed options do not matter here.
				options as never,
			),
		).toThrow(/value-preserving field validators \(field "role"\)/)
	})

	it('rejects a nested caught field', () => {
		expect(() =>
			kVariantTable(
				't',
				k.discriminatedUnion('kind', [
					k.object({ kind: k.literal('a'), n: k.array(k.number().catch(0)) }),
				]),
				// SAFETY: as above.
				options as never,
			),
		).toThrow(/field "n"/)
	})

	it('rejects a caught DTO extension', () => {
		const table = kTable('t', { a: k.string() }, { publicFields: ['a'] })
		// SAFETY: a fallback of the wrong shape is fine; the declaration throws before it is used.
		expect(() =>
			table.toPublicDto({ a: 'x' } as never, { extend: { b: k.number().catch(0) }, values: {} } as never),
		).toThrow(/value-preserving/)
	})
})

describe('catch in discriminated unions', () => {
	it('rejects a caught option', () => {
		expect(() =>
			k.discriminatedUnion('kind', [
				k.object({ kind: k.literal('a'), n: k.number() }).catch({ kind: 'a', n: 0 }),
			]),
		).toThrow(/option 0 carries \.catch\(\); put the catch on the whole union/)
	})

	it('rejects a caught discriminator', () => {
		expect(() =>
			k.discriminatedUnion('kind', [k.object({ kind: k.literal('a').catch('a'), n: k.number() })]),
		).toThrow(/'kind' field of option 0 carries \.catch\(\)/)
	})

	it('a catch on the whole union works', () => {
		const schema = k
			.discriminatedUnion('kind', [
				k.object({ kind: k.literal('a'), n: k.number() }),
				k.object({ kind: k.literal('b'), s: k.string() }),
			])
			.catch({ kind: 'a', n: 0 })
		expect(schema.parse({ kind: 'b', s: 'x' })).toEqual({ kind: 'b', s: 'x' })
		expect(schema.parse(null)).toEqual({ kind: 'a', n: 0 })
		expect(schema.parse({ kind: 'c' })).toEqual({ kind: 'a', n: 0 })
		expect(schema.parse('x')).toEqual({ kind: 'a', n: 0 })
		expect(runDeclared(schema, 42)).toEqual({ kind: 'a', n: 0 })
		expect(schema.validator.kind).toBe('any')
	})

	it('a non-object is an invalid_type issue on every path', () => {
		const schema = k.discriminatedUnion('kind', [
			k.object({ kind: k.literal('a'), n: k.number().refine((n) => n > 0) }),
		])
		for (const value of [null, 'x', 1, []]) {
			expect(schema.safeParse(value)).toMatchObject({
				success: false,
				issues: [{ code: 'invalid_type' }],
			})
			expect(() => runDeclared(schema, value)).toThrow(/expected object/)
		}
	})
})

describe('JSON Schema for catch', () => {
	it('a caught field is not required on the input side', () => {
		const schema = k.object({ a: k.string().catch('x'), b: k.string() })
		expect(schema.parse({ b: 'y' })).toEqual({ a: 'x', b: 'y' })
		expect(toJsonSchema(schema).required).toEqual(['b'])
	})

	it('the output side keeps the shape but not the checks', () => {
		expect(toJsonSchema(k.number().min(5).catch(0), { io: 'output' })).toEqual({ type: 'number' })
		expect(
			toJsonSchema(k.object({ s: k.string().min(3).regex(/a/), d: k.isoDate() }).catch({ s: '', d: '' }), {
				io: 'output',
			}),
		).toEqual({
			type: 'object',
			properties: { s: { type: 'string' }, d: { type: 'string' } },
			additionalProperties: false,
			required: ['s', 'd'],
		})
		expect(toJsonSchema(k.string().nullable().catch(null), { io: 'output' })).toEqual({
			anyOf: [{ type: 'string' }, { type: 'null' }],
		})
	})
})
