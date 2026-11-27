import { describe, expect, it } from 'vite-plus/test'
import { toJsonSchema } from '../src/json-schema'
import { k } from '../src/k'
import { runDeclared } from '../src/k/parse'
import { kTable } from '../src/table'
import { toZod } from '../src/zod'

const issue = (result: {
	success: boolean
	issues?: readonly { code: string; message: string }[]
}) => (result.success ? [] : (result.issues ?? []).map(({ code, message }) => [code, message]))

describe('k.int64 bounds', () => {
	it('min, max and the sign checks compare bigints exactly', () => {
		const amount = k
			.int64()
			.min(0n)
			.max(2n ** 63n - 1n)
		expect(amount.parse(0n)).toBe(0n)
		expect(amount.parse(2n ** 63n - 1n)).toBe(2n ** 63n - 1n)
		expect(issue(amount.safeParse(-1n))).toEqual([
			['too_small', 'Too small: expected bigint to be >=0'],
		])
		expect(issue(amount.safeParse(2n ** 63n))).toEqual([
			['too_big', `Too big: expected bigint to be <=${2n ** 63n - 1n}`],
		])
		// One apart beyond 2^53, where a double cannot tell them apart.
		const edge = 2n ** 60n
		expect(
			k
				.int64()
				.max(edge)
				.safeParse(edge + 1n).success,
		).toBe(false)
		expect(k.int64().max(edge).safeParse(edge).success).toBe(true)
		expect(
			k
				.int64()
				.min(edge + 1n)
				.safeParse(edge).success,
		).toBe(false)
	})

	it('positive, nonnegative, negative and nonpositive', () => {
		expect(issue(k.int64().positive().safeParse(0n))).toEqual([
			['too_small', 'Too small: expected bigint to be >0'],
		])
		expect(k.int64().positive().parse(1n)).toBe(1n)
		expect(k.int64().nonnegative().parse(0n)).toBe(0n)
		expect(issue(k.int64().nonnegative('no debt').safeParse(-1n))).toEqual([
			['too_small', 'no debt'],
		])
		expect(issue(k.int64().negative().safeParse(0n))).toEqual([
			['too_big', 'Too big: expected bigint to be <0'],
		])
		expect(k.int64().nonpositive().parse(0n)).toBe(0n)
		expect(k.int64().nonpositive({ error: 'credit' }).safeParse(1n)).toMatchObject({
			issues: [{ code: 'too_big', message: 'credit' }],
		})
		expect(issue(k.int64().min(0n).safeParse(1)).map(([code]) => code)).toEqual(['invalid_type'])
	})

	it('runs at a function boundary and is allowed on a table field', () => {
		const args = k.object({ amount: k.int64().positive(), fee: k.int64().min(0n).optional() })
		expect(args.validator.fields.amount.kind).toBe('int64')
		expect(() => runDeclared(args, { amount: 0n })).toThrow()
		expect(() => runDeclared(args, { amount: 1n, fee: -1n })).toThrow()
		expect(runDeclared(args, { amount: 1n, fee: 0n })).toEqual({ amount: 1n, fee: 0n })
		const ledger = kTable('ledger', { amount: k.int64().min(0n) })
		expect(ledger.insertSchema.safeParse({ amount: -1n }).success).toBe(false)
		expect(ledger.insertSchema.parse({ amount: 5n })).toEqual({ amount: 5n })
	})

	it('JSON Schema states a bound a JSON number holds exactly; Zod carries every bound', () => {
		expect(toJsonSchema(k.int64().min(0n).max(100n))).toMatchObject({
			type: 'integer',
			minimum: 0,
			maximum: 100,
		})
		expect(toJsonSchema(k.int64().positive())).toMatchObject({ exclusiveMinimum: 0 })
		expect(toJsonSchema(k.int64().max(2n ** 63n - 1n))).not.toHaveProperty('maximum')
		const zod = toZod(
			k
				.int64()
				.positive()
				.max(2n ** 60n),
		)
		expect(zod.safeParse(1n).success).toBe(true)
		expect(zod.safeParse(0n).success).toBe(false)
		expect(zod.safeParse(2n ** 60n + 1n).success).toBe(false)
	})
})
