import { describe, expect, it } from 'vitest'
import { k, KValidationError } from '../src/k'

const messages = (result: { success: boolean; issues?: readonly { message: string }[] }) =>
	result.success ? [] : (result.issues ?? []).map((issue) => issue.message)

describe("Zod 4's error key in check options", () => {
	it('is read as the refine message, with the path kept', () => {
		const schema = k
			.object({ a: k.string().optional() })
			.refine((value) => value.a !== undefined, { error: 'needed', path: ['a'] })
		const result = schema.safeParse({})
		expect(result.success).toBe(false)
		if (!result.success) expect(result.issues).toEqual([{ path: ['a'], code: 'custom', message: 'needed' }])
	})

	it('loses to message when both are given', () => {
		const schema = k.string().refine(() => false, { message: 'mine', error: 'zod' })
		expect(messages(schema.safeParse('x'))).toEqual(['mine'])
	})

	it('is accepted by the string and number checks as an options object', () => {
		expect(messages(k.string().min(2, { error: 'short' }).safeParse('a'))).toEqual(['short'])
		expect(messages(k.string().max(1, { message: 'long' }).safeParse('ab'))).toEqual(['long'])
		expect(messages(k.string().regex(/x/, { error: 'no x' }).safeParse('a'))).toEqual(['no x'])
		expect(messages(k.number().int({ error: 'whole' }).safeParse(1.5))).toEqual(['whole'])
		expect(messages(k.number().finite({ error: 'finite' }).safeParse(Number.NaN))).toEqual(['finite'])
		expect(messages(k.int().safe({ error: 'unsafe' }).safeParse(2 ** 60))).toEqual(['unsafe'])
		expect(messages(k.number().positive({ error: 'pos' }).safeParse(0))).toEqual(['pos'])
		expect(messages(k.array(k.string()).length(1, { error: 'one' }).safeParse([]))).toEqual(['one'])
	})

	it('refuses a Zod error map function at declaration and in types', () => {
		// @ts-expect-error a function-valued error is Zod's error map, which k does not support
		expect(() => k.string().refine(() => true, { error: () => 'x' })).toThrow(/error map/)
		// @ts-expect-error same for check options
		expect(() => k.string().min(1, { error: () => 'x' })).toThrow(/\.min\(\) options/)
	})

	it('makes unknown option keys a type error', () => {
		// @ts-expect-error `params` is not a k check option
		k.string().refine(() => true, { message: 'x', params: {} })
		// @ts-expect-error `abort` is not a k check option
		k.string().min(1, { abort: true })
	})
})

describe('KValidationError', () => {
	it('carries no kit stack frames and leaves the stack limit as it was', () => {
		const before = Error.stackTraceLimit
		const result = (() => {
			try {
				k.string().min(3).parse('a')
			} catch (error) {
				return error
			}
		})()
		if (!(result instanceof KValidationError)) throw new Error('expected a KValidationError')
		const stack = String(result.stack)
		expect(stack).not.toMatch(/\bat\b/)
		expect(stack).toContain('VALIDATION')
		expect(Error.stackTraceLimit).toBe(before)
		expect(new Error('genuine').stack).toMatch(/\bat\b/)
	})
})
