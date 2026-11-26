import { describe, expect, it } from 'vitest'
import { k } from '../src/k'

const range = k
	.object({ from: k.number(), to: k.number(), note: k.string().min(1).optional() })
	.refine((value) => value.from <= value.to, { message: 'from after to', path: ['to'] })

describe('derived objects and object-level checks', () => {
	it('throws on every derivation that would drop object-level checks', () => {
		expect(() => range.pick('from')).toThrow(
			'k.object().pick() would drop 1 object-level check (refine, check or overwrite on the object): pass { dropChecks: true } to drop it',
		)
		expect(() => range.omit('note')).toThrow('omit() would drop 1 object-level check')
		expect(() => range.partial()).toThrow('partial() would drop 1 object-level check')
		expect(() => range.required()).toThrow('required() would drop 1 object-level check')
		expect(() => range.required('note')).toThrow('required() would drop')
		expect(() => range.extend({})).toThrow(
			'extend() would drop 1 object-level check (refine, check or overwrite on the object): pass { dropChecks: true } to drop it, or pass { keepChecks: true } to run them on the extended object',
		)
		const twice = range.check(() => {})
		expect(() => twice.pick('to')).toThrow('would drop 2 object-level checks')
	})

	it('drops the checks with { dropChecks: true }', () => {
		const bad = { from: 2, to: 1 }
		expect(range.safeParse(bad).success).toBe(false)
		expect(range.pick('from', 'to', { dropChecks: true }).safeParse(bad).success).toBe(true)
		expect(range.omit('note', { dropChecks: true }).safeParse(bad).success).toBe(true)
		expect(range.partial({ dropChecks: true }).safeParse(bad).success).toBe(true)
		expect(range.required({ dropChecks: true }).safeParse({ ...bad, note: 'x' }).success).toBe(true)
		expect(range.required('note', { dropChecks: true }).safeParse(bad).success).toBe(false)
		expect(range.extend({}, { dropChecks: true }).safeParse(bad).success).toBe(true)
	})

	it('extend keeps the checks with { keepChecks: true }, in declared order', () => {
		const order: string[] = []
		const base = k
			.object({ a: k.number() })
			.refine(() => (order.push('first'), true))
			.check(() => void order.push('second'))
		const extended = base.extend({ b: k.string() }, { keepChecks: true })
		expect(extended.parse({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' })
		expect(order).toEqual(['first', 'second'])
		const cloned = range.extend({}, { keepChecks: true })
		const result = cloned.safeParse({ from: 2, to: 1 })
		expect(result.success).toBe(false)
		if (!result.success) expect(result.issues[0]).toMatchObject({ path: ['to'], message: 'from after to' })
		expect(cloned.validator).toEqual(range.validator)
	})

	it('field-level checks travel with their fields and checkless receivers need no options', () => {
		const plain = k.object({ name: k.string().min(2), n: k.number().optional() })
		expect(plain.pick('name').safeParse({ name: 'a' }).success).toBe(false)
		expect(plain.omit('n').safeParse({ name: 'a' }).success).toBe(false)
		expect(plain.extend({}).safeParse({ name: 'a' }).success).toBe(false)
		expect(plain.partial().safeParse({ name: 'a' }).success).toBe(false)
		expect(plain.required().safeParse({ name: 'ab' }).success).toBe(false)
		expect(range.describe('r').strip().safeParse({ from: 2, to: 1, x: 1 }).success).toBe(false)
		expect(range.optional().safeParse({ from: 2, to: 1 }).success).toBe(false)
		expect(range.nullable().safeParse({ from: 2, to: 1 }).success).toBe(false)
	})

	it('a description alone is not an object-level check', () => {
		expect(() => k.object({ a: k.string() }).describe('x').pick('a')).not.toThrow()
	})
})
