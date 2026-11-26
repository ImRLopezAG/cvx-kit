import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'
import { toJsonSchema } from '../src/json-schema'
import { k } from '../src/k'
import { hasDeclaredBehaviour, runDeclared } from '../src/k/parse'
import { kTable } from '../src/table'
import { toZod } from '../src/zod'

function json(validator: GenericValidator) {
	// SAFETY: Convex validators expose the json getter at runtime; declarations mark it internal.
	return (validator as GenericValidator & { readonly json: ValidatorJSON }).json
}

class Payload {
	readonly id = 'p1'
	readonly extra = 1
	get derived(): string {
		return 'from-prototype'
	}
}

describe('loose objects', () => {
	const webhook = k.object({ id: k.string(), amount: k.number().default(0) }).loose()

	it('validates the declared fields and keeps unknown keys unchanged', () => {
		const input = { id: 'evt', amount: 5, livemode: true, data: { nested: 1 } }
		expect(webhook.parse(input)).toBe(input)
		expect(webhook.parse({ id: 'evt', $x: 1 })).toEqual({ id: 'evt', amount: 0, $x: 1 })
		expect(webhook.safeParse({ id: 1, other: 2 })).toMatchObject({
			success: false,
			issues: [{ path: ['id'], code: 'invalid_type' }],
		})
		expect(k.looseObject({ id: k.string() }).parse({ id: 'a', b: 2 })).toEqual({ id: 'a', b: 2 })
	})

	it('is hardened like a stripped object', () => {
		const attack = JSON.parse('{"id":"a","__proto__":{"admin":true},"constructor":1}')
		const out = webhook.parse(attack)
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
		expect(Object.hasOwn(out, '__proto__')).toBe(true)
		expect(Object.hasOwn(out, 'constructor')).toBe(true)
		expect(Object.hasOwn(Object.prototype, 'admin')).toBe(false)
		const fromInstance = k.object({ id: k.string() }).loose().parse(new Payload())
		expect(fromInstance).toEqual({ id: 'p1', extra: 1 })
		expect(Object.getPrototypeOf(fromInstance)).toBe(Object.prototype)
		const inherited = Object.create({ id: 'inherited', other: 1 })
		expect(k.object({ id: k.string() }).loose().safeParse(inherited).success).toBe(false)
	})

	it('keeps the closed native object, as v1 converted z.looseObject', () => {
		const strict = k.object({ id: k.string(), amount: k.number().default(0) })
		expect(json(webhook.validator)).toEqual(json(strict.validator))
		expect(json(webhook.outputValidator)).toEqual(json(strict.outputValidator))
		expect(hasDeclaredBehaviour(k.object({ id: k.string() }).loose())).toBe(false)
		expect(() => kTable('loose', { meta: k.object({ a: k.string() }).loose() })).not.toThrow()
	})

	it('converts to JSON Schema and Zod', () => {
		expect(toJsonSchema(webhook)).toMatchObject({ additionalProperties: true })
		expect(toZod(k.looseObject({ a: k.string() })).parse({ a: 'x', b: 1 })).toEqual({ a: 'x', b: 1 })
	})
})

describe('k.jsonObject()', () => {
	const output = k.jsonObject()

	it('accepts plain objects of JSON values with any Convex value keys', () => {
		const step = { _id: 'abc', _creationTime: 1, nested: { _tag: 'x', list: [1, 'a', null] } }
		expect(output.parse(step)).toBe(step)
		expect(output.parse({})).toEqual({})
	})

	it('rejects arrays, null, instances and non-JSON values', () => {
		for (const value of [[], null, 'x', new Payload(), new Map()])
			expect(output.safeParse(value).success).toBe(false)
		expect(output.safeParse({ a: undefined })).toMatchObject({
			success: false,
			issues: [{ path: ['a'], code: 'invalid_type' }],
		})
		expect(output.safeParse({ a: [1, Number.NaN] })).toMatchObject({
			success: false,
			issues: [{ path: ['a', 1], code: 'invalid_type' }],
		})
	})

	it("rejects keys Convex refuses in any object value, naming Convex's rule", () => {
		expect(output.safeParse({ a: { $ref: 1 } })).toMatchObject({
			success: false,
			issues: [
				{
					path: ['a', '$ref'],
					code: 'invalid_format',
					message:
						'Invalid object key: not a Convex field name',
				},
			],
		})
		expect(output.safeParse({ 'é': 1 }).success).toBe(false)
	})

	it('is v.any() natively, so the boundary checks the whole value', () => {
		expect(json(output.validator)).toEqual({ type: 'any' })
		expect(hasDeclaredBehaviour(output)).toBe(true)
		expect(() => runDeclared(output, [1])).toThrow()
		expect(toJsonSchema(output)).toEqual({ type: 'object' })
		expect(toZod(output).parse({ _id: 'a' })).toEqual({ _id: 'a' })
		expect(output['~standard'].validate([])).toMatchObject({ issues: [{ path: [] }] })
	})
})
