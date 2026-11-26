import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { toJsonSchema } from '../src/json-schema'
import { k } from '../src/k'
import { toZod } from '../src/zod'

function json(validator: GenericValidator): ValidatorJSON {
	// SAFETY: every native validator carries its JSON form, which convex/values types as protected.
	return (validator as GenericValidator & { readonly json: ValidatorJSON }).json
}

describe('k.record with a finite literal key set', () => {
	const byStatus = k.record(k.enum(['a', 'b']), k.number())

	it('compiles to an object with one required field per value, never a literal-keyed record', () => {
		expect(json(byStatus.validator)).toEqual({
			type: 'object',
			value: {
				a: { fieldType: { type: 'number' }, optional: false },
				b: { fieldType: { type: 'number' }, optional: false },
			},
		})
		expect(k.record(k.literal('x'), k.string()).validator.kind).toBe('object')
		expect(
			json(k.record(k.union([k.literal('x'), k.enum(['y', 'z'])]), k.string()).validator),
		).toMatchObject({ type: 'object', value: { x: {}, y: {}, z: {} } })
	})

	it('types the output as Record<keys, V>', () => {
		expectTypeOf(byStatus._output).toEqualTypeOf<{ a: number; b: number }>()
		expectTypeOf<k.infer<typeof byStatus>>().toMatchTypeOf<Record<'a' | 'b', number>>()
	})

	it('reports a missing key and an unknown key', () => {
		expect(byStatus.safeParse({ a: 1, b: 2 }).success).toBe(true)
		expect(byStatus.safeParse({ a: 1 }).success).toBe(false)
		expect(byStatus.safeParse({ a: 1, b: 2, c: 3 }).success).toBe(false)
	})

	it('converts to JSON Schema and Zod as an object', () => {
		expect(toJsonSchema(byStatus)).toMatchObject({
			type: 'object',
			required: ['a', 'b'],
			additionalProperties: false,
		})
		const zod = toZod(byStatus)
		expect(zod.safeParse({ a: 1, b: 2 }).success).toBe(true)
		expect(zod.safeParse({ a: 1 }).success).toBe(false)
	})

	it('keeps string and id keys a native record', () => {
		expect(k.record(k.string(), k.number()).validator.kind).toBe('record')
		expect(k.record(k.id('users'), k.number()).validator.kind).toBe('record')
		expect(k.record(k.union([k.id('a'), k.id('b')]), k.number()).validator.kind).toBe('record')
	})
})

describe('k.partialRecord', () => {
	const counts = k.partialRecord(k.enum(['a', 'b']), k.number())

	it('builds an object with one optional field per value', () => {
		expect(json(counts.validator)).toEqual({
			type: 'object',
			value: {
				a: { fieldType: { type: 'number' }, optional: true },
				b: { fieldType: { type: 'number' }, optional: true },
			},
		})
		expectTypeOf(counts._output).toEqualTypeOf<{ a?: number | undefined; b?: number | undefined }>()
		expect(counts.safeParse({}).success).toBe(true)
		expect(counts.safeParse({ c: 1 }).success).toBe(false)
	})

	it('refuses a string key', () => {
		// @ts-expect-error a partial record needs a finite literal key set
		expect(() => k.partialRecord(k.string(), k.number())).toThrow(/finite set of string literal/)
	})
})

describe('record key errors at declaration', () => {
	it('names the kind of an unsupported key', () => {
		// @ts-expect-error a number is not a record key
		expect(() => k.record(k.number(), k.number())).toThrow(/got 'number'/)
		// @ts-expect-error a numeric literal is not a record key
		expect(() => k.record(k.literal(1), k.number())).toThrow(/string literal, got 1/)
		// @ts-expect-error a union mixing strings and literals has no valid native form
		expect(() => k.record(k.union([k.string(), k.literal('a')]), k.number())).toThrow(/cannot mix/)
	})

	it('refuses literal keys Convex refuses as field names', () => {
		expect(() => k.record(k.enum(['$a']), k.number())).toThrow(/'\$a' is not a valid Convex field/)
		expect(() => k.record(k.literal(''), k.number())).toThrow(/not a valid Convex field/)
		expect(() => k.record(k.literal('é'), k.number())).toThrow(/not a valid Convex field/)
		expect(k.record(k.literal('_a'), k.number()).validator.kind).toBe('object')
	})
})

describe('object field names', () => {
	it('refuses a field Convex refuses when the validator is first built', () => {
		expect(() => k.object({ $bad: k.string() }).validator).toThrow(/field '\$bad'/)
		expect(() => k.object({ 'naïve': k.string() }).validator).toThrow(/not a valid Convex field/)
		expect(k.object({ _id: k.string(), 'a b': k.string() }).validator.kind).toBe('object')
	})
})
