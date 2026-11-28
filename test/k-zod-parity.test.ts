import { describe, expect, it } from 'vitest'
import { toJsonSchema } from '../src/json-schema'
import { k, type AnyKSchema } from '../src/k'
import { toZod } from '../src/zod'

function issueOf(schema: AnyKSchema, value: number) {
	const result = schema.safeParse(value)
	return 'issues' in result && Array.isArray(result.issues)
		? result.issues.map(({ code, message }) => ({ code, message }))
		: []
}

describe('number checks', () => {
	it('positive, negative, nonnegative and nonpositive bound at zero with Zod codes and messages', () => {
		expect(k.number().positive().safeParse(1).success).toBe(true)
		expect(issueOf(k.number().positive(), 0)).toEqual([
			{ code: 'too_small', message: 'Too small: expected number to be >0' },
		])
		expect(issueOf(k.number().negative(), 0)).toEqual([
			{ code: 'too_big', message: 'Too big: expected number to be <0' },
		])
		expect(k.number().nonnegative().safeParse(0).success).toBe(true)
		expect(issueOf(k.number().nonnegative(), -1)).toEqual([
			{ code: 'too_small', message: 'Too small: expected number to be >=0' },
		])
		expect(k.number().nonpositive().safeParse(0).success).toBe(true)
		expect(issueOf(k.number().nonpositive(), 1)).toEqual([
			{ code: 'too_big', message: 'Too big: expected number to be <=0' },
		])
		expect(issueOf(k.number().positive('must be positive'), -1)[0].message).toBe('must be positive')
		expect(k.number().positive().safeParse(Number.NaN).success).toBe(false)
	})

	it('finite rejects NaN and the infinities; safe rejects floats and unsafe integers', () => {
		expect(k.number().finite().safeParse(1.5).success).toBe(true)
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
			expect(issueOf(k.number().finite(), value)).toEqual([
				{ code: 'invalid_type', message: 'Invalid input: expected a finite number' },
			])
		expect(k.number().safe().safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true)
		expect(issueOf(k.number().safe(), 1.5)).toEqual([
			{ code: 'not_integer', message: 'Expected an integer' },
		])
		expect(issueOf(k.number().safe(), Number.MAX_SAFE_INTEGER + 1)[0].code).toBe('too_big')
		expect(issueOf(k.number().safe(), Number.MIN_SAFE_INTEGER - 1)[0].code).toBe('too_small')
		expect(issueOf(k.number().safe(), Number.NaN)[0].code).toBe('not_integer')
	})

	it('leave the native validator a plain v.number()', () => {
		const checked = k.number().positive().nonnegative().negative().nonpositive().finite().safe()
		expect(checked.validator).toBe(k.number().validator)
	})

	it('describe themselves in JSON Schema and convert to Zod', () => {
		expect(toJsonSchema(k.number().positive().negative())).toEqual({
			type: 'number',
			exclusiveMinimum: 0,
			exclusiveMaximum: 0,
		})
		expect(toJsonSchema(k.number().nonnegative())).toEqual({ type: 'number', minimum: 0 })
		expect(toJsonSchema(k.number().safe())).toEqual({
			type: 'integer',
			minimum: Number.MIN_SAFE_INTEGER,
			maximum: Number.MAX_SAFE_INTEGER,
		})
		const zod = toZod(k.number().positive().safe())
		expect(zod.safeParse(1).success).toBe(true)
		expect(zod.safeParse(0).success).toBe(false)
		expect(zod.safeParse(1.5).success).toBe(false)
		expect(toZod(k.number().negative()).safeParse(-1).success).toBe(true)
		expect(toZod(k.number().negative()).safeParse(0).success).toBe(false)
	})
})

describe('array, object and enum members', () => {
	it('KArray.element is the element schema', () => {
		const element = k.string().min(1)
		expect(k.array(element).min(1).element).toBe(element)
	})

	it('KObject.keyof() is an enum of the keys in order', () => {
		const keys = k.object({ b: k.string(), a: k.number() }).keyof()
		expect(keys.options).toEqual(['b', 'a'])
		expect(keys.safeParse('a').success).toBe(true)
		expect(keys.safeParse('c').success).toBe(false)
	})

	it('KObject.required() inverts partial(), for every field or the named ones', () => {
		const base = k.object({ a: k.string().min(1), b: k.number(), c: k.string().default('x') })
		const patch = base.partial()
		const all = patch.required()
		expect(all.validator).toEqual(base.validator)
		expect(all.safeParse({ a: '', b: 1, c: 'y' }).success).toBe(false)
		const some = patch.required('a')
		expect(some.safeParse({ a: 'x' }).success).toBe(true)
		expect(some.safeParse({}).success).toBe(false)
		const defaulted = base.required()
		expect(defaulted.parse({ a: 'x', b: 1 })).toEqual({ a: 'x', b: 1, c: 'x' })
		const optional = k.object({ a: k.string().optional() })
		expect(optional.required().safeParse({}).success).toBe(false)
	})

	it('k.enum exclude, extract and .enum', () => {
		const status = k.enum(['open', 'done', 'archived'])
		expect(status.enum).toEqual({ open: 'open', done: 'done', archived: 'archived' })
		expect(Object.isFrozen(status.enum)).toBe(true)
		expect(status.exclude(['archived']).options).toEqual(['open', 'done'])
		expect(status.extract(['done', 'open']).options).toEqual(['done', 'open'])
		expect(status.extract(['done']).safeParse('open').success).toBe(false)
		expect(() => status.exclude(['open', 'done', 'archived'])).toThrow(/at least one value/)
		// @ts-expect-error not a value of the enum
		expect(() => status.extract(['missing'])).toThrow(/not a value/)
	})

	it('removeDefault() is unwrap() on a default', () => {
		const inner = k.string().min(1)
		const defaulted = inner.default('x')
		expect(defaulted.removeDefault()).toBe(inner)
		expect(defaulted.removeDefault()).toBe(defaulted.unwrap())
	})
})
