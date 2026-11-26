import { describe, expect, it } from 'vitest'
import { zodToConvex } from 'convex-helpers/server/zod4'
import type { GenericValidator, JSONValue } from 'convex/values'
import { z } from 'zod'
import * as mini from 'zod/mini'
import { k } from '../src/k'
import { toZod } from '../src/zod'

const task = k.object({
	title: k.string().trim().min(1).max(5),
	code: k.string().regex(/^[A-Z]+$/, 'upper only'),
	count: k.number().int().min(0),
	tags: k.array(k.string()).length(2).optional(),
	owner: k.id('users'),
	status: k.enum(['open', 'done']).default('open'),
	note: k.string().nullable(),
	due: k.isoDate().optional(),
	at: k.timestamp().optional(),
})
function json(validator: GenericValidator): JSONValue {
	// SAFETY: native validators carry their JSON form on a non-public `json` property.
	return (validator as GenericValidator & { json: JSONValue }).json
}

const valid = { title: ' ab ', code: 'AB', count: 1, owner: 'u1', note: null }

describe('toZod', () => {
	it('accepts and rejects the same structural inputs as the k schema', () => {
		const zod = toZod(task)
		const inputs = [
			valid,
			{ ...valid, extra: 1 },
			{ ...valid, count: 'x' },
			{ ...valid, note: undefined },
			{ ...valid, tags: ['a', 'b'] },
			{ ...valid, owner: 1 },
			{ ...valid, status: 'other' },
			{ ...valid, due: '2026-02-29' },
			{ ...valid, due: '2028-02-29' },
			{ ...valid, at: -1 },
			[],
			null,
		]
		for (const input of inputs) {
			expect(zod.safeParse(input).success, JSON.stringify(input)).toBe(
				task.safeParse(input).success,
			)
		}
		expect(zod.parse(valid)).toEqual(task.parse(valid))
	})

	it('carries min, max, length, regex, int, trim and defaults', () => {
		const zod = toZod(task)
		expect(zod.safeParse({ ...valid, title: '   ' }).success).toBe(false)
		expect(zod.safeParse({ ...valid, title: 'abcdef' }).success).toBe(false)
		expect(zod.safeParse({ ...valid, count: 1.5 }).success).toBe(false)
		expect(zod.safeParse({ ...valid, count: -1 }).success).toBe(false)
		expect(zod.safeParse({ ...valid, tags: ['a'] }).success).toBe(false)
		const code = zod.safeParse({ ...valid, code: 'ab' })
		expect(code.success ? '' : code.error.issues[0].message).toBe('upper only')
		expect(zod.parse(valid)).toMatchObject({ title: 'ab', status: 'open' })
		expect(toZod(k.string().toUpperCase()).parse('a')).toBe('A')
		expect(z.globalRegistry.get(toZod(k.string().describe('d')))?.description).toBe('d')
	})

	it('does not carry refine or transform, and still validates structure', () => {
		const refined = toZod(k.number().refine((value) => value > 10))
		expect(refined.parse(1)).toBe(1)
		expect(refined.safeParse('x').success).toBe(false)
		const transformed = toZod(
			k
				.string()
				.min(1)
				.transform((value) => value.length),
		)
		expect(transformed.parse('abc')).toBe('abc')
		expect(transformed.safeParse('').success).toBe(false)
		expect(transformed.safeParse(1).success).toBe(false)
	})

	it('converts records, unions, discriminated unions and strip objects', () => {
		expect(toZod(k.record(k.id('users'), k.number().int())).safeParse({ a: 1.5 }).success).toBe(
			false,
		)
		expect(toZod(k.union([k.string(), k.number()])).safeParse(true).success).toBe(false)
		const figure = toZod(
			k.discriminatedUnion('kind', [
				k.object({ kind: k.literal('a'), n: k.number() }),
				k.object({ kind: k.literal('b') }),
			]),
		)
		expect(figure.parse({ kind: 'a', n: 1 })).toEqual({ kind: 'a', n: 1 })
		expect(figure.safeParse({ kind: 'c' }).success).toBe(false)
		expect(toZod(k.object({ a: k.string() }).strip()).parse({ a: 'x', b: 1 })).toEqual({ a: 'x' })
		expect(toZod(k.int64()).parse(1n)).toBe(1n)
		expect(toZod(k.json()).parse({ a: [1] })).toEqual({ a: [1] })
	})

	it('keeps partial() free of defaults and runs a default through the rest of the chain, as k does', () => {
		const patch = k.object({ x: k.string().default('x') }).partial()
		expect(toZod(patch).parse({})).toEqual(patch.parse({}))
		expect(toZod(patch).parse({})).toEqual({})
		const trimmed = k.string().trim().default('  hi  ')
		expect(toZod(trimmed).parse(undefined)).toBe(trimmed.parse(undefined))
		expect(toZod(trimmed).parse(undefined)).toBe('hi')
		const wrapped = k.object({ n: k.number().default(1).optional() })
		expect(toZod(wrapped).parse({})).toEqual(wrapped.parse({}))
	})

	it('keeps describe transparent to the order of normalisers and checks', () => {
		const schema = k.string().min(2).describe('name').trim()
		expect(toZod(schema).safeParse(' x ').success).toBe(schema.safeParse(' x ').success)
		expect(z.globalRegistry.get(toZod(schema))?.description).toBe('name')
	})

	it('produces zod/mini schemas that convex-helpers converts back to the same native validator', () => {
		const schema = k.object({
			owner: k.id('users'),
			title: k.string().min(1),
			tags: k.array(k.string()).optional(),
			note: k.string().nullable(),
			kind: k.enum(['a', 'b']),
		})
		const zod = toZod(schema)
		expect(zod).toBeInstanceOf(mini.ZodMiniType)
		expect(zod).not.toBeInstanceOf(z.ZodType)
		expect(json(zodToConvex(zod))).toEqual(json(schema.validator))
		// A result is extended with zod/mini functions.
		expect(mini.optional(zod).safeParse(undefined).success).toBe(true)
	})

	it('installs .toZod() on every k schema', () => {
		const zod = task.shape.title.toZod()
		expect(zod).toBeInstanceOf(z.core.$ZodType)
		expect(zod.parse(' a ')).toBe('a')
		expect(k.string().optional().toZod().parse(undefined)).toBeUndefined()
	})
})
