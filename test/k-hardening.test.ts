import { describe, expect, it } from 'vitest'
import { k, KValidationError } from '../src/k'
import { runDeclared } from '../src/k/parse'
import type { KType } from '../src/k/types'

/** Reflect.set returns false for a frozen target; turn that into the strict-mode TypeError. */
function badWrite(): never {
	throw new TypeError('write refused')
}

describe('record keys from input', () => {
	const schema = k.record(k.string().trim(), k.any())
	const attack = JSON.parse('{" __proto__ ": {"admin": true}}')

	it('rejects a key that normalises to a key Convex would reject, through parse, safeParse and runDeclared', () => {
		expect(schema.safeParse(attack)).toMatchObject({
			success: false,
			issues: [{ path: [' __proto__ '], code: 'invalid_format' }],
		})
		expect(() => schema.parse(attack)).toThrow(KValidationError)
		expect(() => runDeclared(schema, attack)).toThrow(KValidationError)
		expect(Object.hasOwn(Object.prototype, 'admin')).toBe(false)
	})

	it('applies the Convex record key rule to normalised keys', () => {
		for (const key of [' _id ', ' $x ', '   ', ' é ']) {
			expect(schema.safeParse({ [key]: 1 }).success, key).toBe(false)
		}
		expect(schema.parse({ ' a ': 1 })).toEqual({ a: 1 })
	})

	it('builds outputs with own properties and a plain prototype', () => {
		const lower = k.record(k.string().toLowerCase(), k.number())
		const out = lower.parse({ A: 1, constructor: 2 })
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
		expect(Object.keys(out)).toEqual(['a', 'constructor'])
		expect(Object.hasOwn(out, 'constructor')).toBe(true)
		const strict = k.object({ a: k.string().trim() }).strip()
		const stripped = strict.parse(JSON.parse('{"a":" x ","__proto__":{"admin":true}}'))
		expect(Object.getPrototypeOf(stripped)).toBe(Object.prototype)
		expect(stripped).toEqual({ a: 'x' })
	})
})

describe('numeric bounds', () => {
	it('fail for NaN on any min or max, while a bare number keeps accepting it', () => {
		expect(k.number().min(1).max(10).safeParse(Number.NaN).success).toBe(false)
		expect(k.number().min(1).safeParse(Number.NaN).success).toBe(false)
		expect(k.number().max(1).safeParse(Number.NaN).success).toBe(false)
		expect(k.number().safeParse(Number.NaN).success).toBe(true)
		expect(k.number().safeParse(Number.POSITIVE_INFINITY).success).toBe(true)
		expect(k.number().int().safeParse(Number.NaN).success).toBe(false)
		expect(k.number().int().safeParse(Number.POSITIVE_INFINITY).success).toBe(false)
		expect(k.int().safeParse(Number.NaN).success).toBe(false)
		expect(k.int().safeParse(Number.NEGATIVE_INFINITY).success).toBe(false)
	})
})

describe('discriminated unions', () => {
	it('reject a repeated discriminator value at declaration, naming the option', () => {
		expect(() =>
			k.discriminatedUnion('kind', [
				k.object({ kind: k.literal('a'), x: k.number() }),
				k.object({ kind: k.literal('a'), y: k.number() }),
			]),
		).toThrow(/'kind' value "a" \(option 1 repeats it\)/)
		expect(() =>
			k.discriminatedUnion('kind', [
				k.object({ kind: k.enum(['a', 'b']) }),
				k.object({ kind: k.literal('b'), y: k.number() }),
			]),
		).toThrow(/'kind' value "b"/)
	})

	it('dispatch on every literal of a union-of-literals discriminator', () => {
		const event = k.discriminatedUnion('kind', [
			k.object({ kind: k.union([k.literal('a'), k.literal('b')]), x: k.number() }),
			k.object({ kind: k.literal('c'), y: k.string() }),
		])
		expect(event.parse({ kind: 'b', x: 1 })).toEqual({ kind: 'b', x: 1 })
		expect(event.parse({ kind: 'c', y: 'z' })).toEqual({ kind: 'c', y: 'z' })
		expect(event.safeParse({ kind: 'a', y: 'z' }).success).toBe(false)
		expect(event.safeParse({ kind: 'd' }).success).toBe(false)
	})

	it('name the option and what it found for an unsupported discriminator, at declaration', () => {
		expect(() =>
			k.discriminatedUnion('kind', [
				k.object({ kind: k.literal('a') }),
				k.object({ kind: k.string() }),
			]),
		).toThrow(/option 1 has 'string'/)
		expect(() =>
			// @ts-expect-error an option without the key cannot dispatch
			k.discriminatedUnion('kind', [k.object({ kind: k.literal('a') }), k.object({ other: k.number() })]),
		).toThrow(/option 1 has no 'kind' field/)
	})
})

describe('describe', () => {
	it('does not split a run of normalisers and checks', () => {
		expect(k.string().min(2).describe('name').trim().safeParse(' x ').success).toBe(false)
		expect(k.string().min(2).trim().safeParse(' x ').success).toBe(false)
		expect(k.string().trim().describe('name').min(2).safeParse(' x ').success).toBe(false)
		expect(k.string().min(2).describe('name').trim().parse(' xy ')).toBe('xy')
	})
})

describe('async callbacks', () => {
	it('report an issue when a transform or overwrite returns a promise', () => {
		const transform = k.string().transform(async (value) => value.length)
		expect(transform.safeParse('a')).toMatchObject({
			success: false,
			issues: [{ code: 'custom', message: expect.stringMatching(/async/i) }],
		})
		const asyncOverwrite = async (value: string) => value
		// SAFETY: the cast models a caller that ignores the synchronous overwrite contract.
		const overwrite = k.string().overwrite(asyncOverwrite as never)
		expect(overwrite.safeParse('a').success).toBe(false)
	})
})

describe('declared containers', () => {
	it('are frozen, so a schema cannot change after declaration', () => {
		const profile = k.object({ text: k.string() })
		expect(() => Object.assign(profile.shape, { secret: k.string() })).toThrow(TypeError)
		expect(() => Reflect.set(profile.shape, 'text', k.number()) || badWrite()).toThrow(TypeError)
		expect(profile.safeParse({ text: 'a', secret: 'b' }).success).toBe(false)
		for (const derived of [
			profile.pick('text'),
			profile.omit('text'),
			profile.partial(),
			profile.extend({ n: k.number() }),
		]) {
			expect(Object.isFrozen(derived.shape)).toBe(true)
		}
	})

	it('make mutating the array passed to union or enum have no effect', () => {
		const values: ['a', 'b'] = ['a', 'b']
		const status = k.enum(values)
		const members: [KType, KType] = [k.string(), k.number()]
		const either = k.union(members)
		expect(() => Reflect.set(values, 2, 'c') || badWrite()).toThrow(TypeError)
		expect(() => Reflect.set(members, 1, k.boolean()) || badWrite()).toThrow(TypeError)
		expect(status.safeParse('c').success).toBe(false)
		expect(either.safeParse(1).success).toBe(true)
		expect(either.safeParse(true).success).toBe(false)
		const figure = k.discriminatedUnion('kind', [k.object({ kind: k.literal('a') })])
		expect(Object.isFrozen(figure.options)).toBe(true)
		const options = { message: 'm', path: ['a'] }
		k.object({ a: k.string() }).refine(() => true, options)
		expect(Object.isFrozen(options)).toBe(true)
		expect(Object.isFrozen(options.path)).toBe(true)
	})
})

describe('timestamp range', () => {
	const max = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

	it('accepts 1970 through the end of 9999 and rejects beyond, without throwing', () => {
		expect(k.timestamp().parse(max)).toBe(max)
		expect(k.timestamp().safeParse(max + 1)).toMatchObject({ issues: [{ code: 'too_big' }] })
		expect(k.timestamp().safeParse(8_640_000_000_000_001).success).toBe(false)
		expect(k.timestamp().toIsoDate().safeParse(8_640_000_000_000_001).success).toBe(false)
		expect(k.timestamp().toIsoDate().safeParse(253_402_300_800_000).success).toBe(false)
		expect(k.timestamp().toIsoDate().parse(max)).toBe('9999-12-31')
		expect(k.timestamp().toIsoDateTime().parse(0)).toBe('1970-01-01T00:00:00.000Z')
	})

	it('reports conversions outside the range as issues', () => {
		const pushed = k
			.timestamp()
			.overwrite((value) => value * 1e6)
			.toIsoDate()
		expect(pushed.safeParse(max)).toMatchObject({
			success: false,
			issues: [{ code: 'invalid_value' }],
		})
		expect(k.isoDate().toTimestamp().safeParse('1969-12-31')).toMatchObject({
			success: false,
			issues: [{ code: 'invalid_value' }],
		})
		expect(k.isoDate().toTimestamp().parse('1970-01-01')).toBe(0)
		expect(k.isoDate().toTimestamp().parse('9999-12-31')).toBe(Date.UTC(9999, 11, 31))
		expect(k.isoDateTime().toTimestamp().safeParse('9999-12-31T23:59:59-01:00').success).toBe(false)
		expect(k.isoDateTime().toTimestamp().safeParse('1970-01-01T00:30:00+01:00').success).toBe(false)
		expect(k.isoDateTime().toTimestamp().parse('9999-12-31T23:59:59.999Z')).toBe(max)
	})
})

describe('class instances', () => {
	class TaggedError extends Error {
		readonly _tag = 'X'
	}
	class Shadowed {
		get _tag(): string {
			return 'from-prototype'
		}
	}

	it('a .strip() object reads only own enumerable properties into a fresh plain object', () => {
		const schema = k.object({ _tag: k.string() }).strip()
		const out = schema.parse(new TaggedError('boom'))
		expect(out).toEqual({ _tag: 'X' })
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
		expect(schema.safeParse(new Shadowed())).toMatchObject({
			success: false,
			issues: [{ path: ['_tag'], code: 'invalid_type' }],
		})
		const polluted = Object.create({ _tag: 'inherited' })
		expect(schema.safeParse(polluted).success).toBe(false)
	})

	it('a strict object, a record and a discriminated union still reject them with a plain-object message', () => {
		const strict = k.object({ _tag: k.string() }).safeParse(new TaggedError())
		expect(strict).toMatchObject({
			success: false,
			issues: [
				{
					code: 'invalid_type',
					message: 'Invalid input: expected a plain object, received an instance of TaggedError',
				},
			],
		})
		expect(k.record(k.string(), k.any()).safeParse(new Map())).toMatchObject({
			success: false,
			issues: [{ message: 'Invalid input: expected a plain record, received an instance of Map' }],
		})
		expect(k.object({}).safeParse([])).toMatchObject({
			issues: [{ message: 'Invalid input: expected object, received array' }],
		})
	})
})
