import { describe, expect, it } from 'vitest'
import { k } from '../src/k'
import { KDefault, KPipe, KTransform } from '../src/k/schema'

describe('k chain conveniences', () => {
	it('checks exact string and array length', () => {
		expect(k.string().length(2).parse('ab')).toBe('ab')
		expect(k.string().length(2).safeParse('a')).toMatchObject({
			success: false,
			issues: [{ code: 'too_small' }],
		})
		expect(k.string().length(2).safeParse('abc')).toMatchObject({
			success: false,
			issues: [{ code: 'too_big' }],
		})
		expect(k.array(k.number()).length(1).safeParse([1, 2])).toMatchObject({
			success: false,
			issues: [{ code: 'too_big' }],
		})
	})

	it('normalises case and overwrites values without changing the kind', () => {
		expect(k.string().toLowerCase().parse('AbC')).toBe('abc')
		expect(k.string().toUpperCase().parse('abc')).toBe('ABC')
		const rounded = k
			.number()
			.overwrite((value) => Math.round(value))
			.max(2)
		expect(rounded.parse(1.6)).toBe(2)
		expect(rounded.safeParse(2.7).success).toBe(false)
		expect(rounded.max(5)).toBeInstanceOf(rounded.constructor)
	})

	it('lets check add several issues with relative paths', () => {
		const pair = k.object({ a: k.string(), b: k.string() }).check((value, context) => {
			if (value.a === value.b) {
				context.addIssue({ path: ['a'], message: 'same' })
				context.addIssue({ path: ['b'], message: 'same', code: 'invalid_value' })
			}
		})
		const parent = k.object({ pair })
		expect(parent.safeParse({ pair: { a: 'x', b: 'x' } })).toEqual({
			success: false,
			issues: [
				{ path: ['pair', 'a'], code: 'custom', message: 'same' },
				{ path: ['pair', 'b'], code: 'invalid_value', message: 'same' },
			],
		})
		expect(parent.parse({ pair: { a: 'x', b: 'y' } })).toEqual({ pair: { a: 'x', b: 'y' } })
	})

	it('accepts a refine message as a string or an options object', () => {
		const even = k.number().refine((value) => value % 2 === 0, 'must be even')
		expect(even.safeParse(1)).toMatchObject({
			issues: [{ code: 'custom', message: 'must be even' }],
		})
		const fallback = k.number().refine((value) => value > 0)
		expect(fallback.safeParse(0)).toMatchObject({ issues: [{ message: 'Invalid input' }] })
		const options = k.number().refine((value) => value > 0, { message: 'positive' })
		expect(options.safeParse(0)).toMatchObject({ issues: [{ path: [], message: 'positive' }] })
	})

	it('makes transform and pipe distinct kinds, each one record linked to its input', () => {
		const base = k.string()
		const length = base.transform((value) => value.length)
		expect(length).toBeInstanceOf(KTransform)
		expect(length.prev).toBe(base)
		const piped = length.pipe(k.number().min(1))
		expect(piped).toBeInstanceOf(KPipe)
		expect(piped.prev).toBe(length)
		expect(base.op).toBe('string')
		expect(piped.parse('abc')).toBe(3)
		expect(length.refine((value) => value > 1).safeParse('a').success).toBe(false)
	})

	it('records every convenience as one record without compiling anything', () => {
		const schema = k
			.string()
			.trim()
			.toLowerCase()
			.length(3)
			.regex(/^[a-z]+$/)
		const records: string[] = []
		for (let node: { op: string; prev: unknown } | null = schema; node !== null;) {
			records.push(node.op)
			// SAFETY: every chain record's prev is another record or null.
			node = node.prev as { op: string; prev: unknown } | null
		}
		expect(records).toEqual(['regex', 'length', 'lower', 'trim', 'string'])
		expect(schema.plan).toBeUndefined()
		expect(schema.native).toBeUndefined()
	})

	it('applies a default to the output of a transform directly', () => {
		const size = k
			.string()
			.transform((value) => value.length)
			.default(0)
		expect(size).toBeInstanceOf(KDefault)
		expect(size.parse(undefined)).toBe(0)
		expect(size.parse('ab')).toBe(2)
	})

	it('applies an inner default under optional, as partial() relies on', () => {
		expect(k.string().default('x').optional().parse(undefined)).toBe('x')
		expect(k.string().optional().default('x').parse(undefined)).toBe('x')
	})
})
