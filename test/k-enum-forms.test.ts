import { describe, expect, it } from 'vite-plus/test'
import { k } from '../src/k'
import { toJsonSchema } from '../src/json-schema'
import { toZod } from '../src/zod'

describe('enum forms', () => {
	it('normalizes string object values to the array form', () => {
		const schema = k.enum({ A: 'a', B: 'b' })
		const array = k.enum(['a', 'b'])
		expect(schema.parse('a')).toBe('a')
		expect(schema.safeParse('A').success).toBe(false)
		expect(schema.validator).toEqual(array.validator)
		expect(toJsonSchema(schema)).toEqual(toJsonSchema(array))
		for (const value of ['a', 'b', 'A'])
			expect(toZod(schema).safeParse(value)).toEqual(toZod(array).safeParse(value))
	})

	it('refuses empty and non-string definitions', () => {
		// SAFETY: invalid JavaScript inputs must fail at definition time.
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- deliberately exercise untyped definitions through the public factory.
		const make = k.enum as (value: unknown) => ReturnType<typeof k.enum>
		for (const value of ['abc', {}, { A: 1 }, [], { 0: 'A', A: 0 }, null, new Date()])
			expect(() => make(value)).toThrow(TypeError)
	})
})
