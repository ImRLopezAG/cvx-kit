import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'
import { k, KValidationError, type KIssue } from '../src/k'
import { containsTransform, hasDeclaredBehaviour, runDeclared } from '../src/k/parse'

function issuesOf(result: { success: boolean; issues?: KIssue[] }): KIssue[] {
	expect(result.success).toBe(false)
	return result.issues ?? []
}

describe('k parse', () => {
	it('trims before checking and reports too_small at the path', () => {
		const schema = k.object({ name: k.string().trim().min(1) })
		expect(schema.parse({ name: '  a ' })).toEqual({ name: 'a' })
		expect(issuesOf(schema.safeParse({ name: '   ' }))).toEqual([
			{ path: ['name'], code: 'too_small', message: expect.any(String) },
		])
	})

	it('runs normalisers before checks whatever their declared order', () => {
		expect(k.string().min(1).trim().safeParse('  ').success).toBe(false)
		expect(k.string().max(2).toLowerCase().trim().parse(' AB ')).toBe('ab')
	})

	it('reports nested paths including array indexes', () => {
		const schema = k.object({ items: k.array(k.object({ qty: k.number().int() })) })
		expect(issuesOf(schema.safeParse({ items: [{ qty: 1 }, { qty: 1.5 }] }))).toEqual([
			{ path: ['items', 1, 'qty'], code: 'not_integer', message: 'Expected an integer' },
		])
	})

	it('reports one issue per failing field in one parse', () => {
		const schema = k.object({ a: k.string(), b: k.number().min(3), c: k.boolean() })
		const issues = issuesOf(schema.safeParse({ a: 1, b: 2, c: 'x' }))
		expect(issues.map((issue) => [issue.path, issue.code])).toEqual([
			[['a'], 'invalid_type'],
			[['b'], 'too_small'],
			[['c'], 'invalid_type'],
		])
	})

	it('uses a custom message on a check', () => {
		const schema = k.string().regex(/^\d+$/, 'digits only')
		expect(issuesOf(schema.safeParse('x'))).toEqual([
			{ path: [], code: 'invalid_format', message: 'digits only' },
		])
		expect(issuesOf(k.string().min(2, 'too short').safeParse('a'))[0].message).toBe('too short')
	})

	it('applies a default only to undefined', () => {
		const schema = k.object({ s: k.string().default('x'), n: k.string().nullable().default('y') })
		expect(schema.parse({})).toEqual({ s: 'x', n: 'y' })
		expect(schema.parse({ s: '', n: null })).toEqual({ s: '', n: null })
		expect(k.string().default('x').safeParse(null).success).toBe(false)
	})

	it('feeds a transform into a pipe and reports a failure in the target', () => {
		const schema = k
			.string()
			.transform((value) => Number(value))
			.pipe(k.number().int().min(1))
		expect(schema.parse('3')).toBe(3)
		expect(issuesOf(schema.safeParse('0.5')).map((issue) => issue.code)).toEqual([
			'not_integer',
			'too_small',
		])
		expect(issuesOf(schema.safeParse(3))[0].code).toBe('invalid_type')
	})

	it('lets an object refinement attach its issue to a field', () => {
		const range = k
			.object({ from: k.number(), to: k.number() })
			.refine((value) => value.from <= value.to, { message: 'from after to', path: ['to'] })
		expect(range.parse({ from: 1, to: 2 })).toEqual({ from: 1, to: 2 })
		expect(issuesOf(range.safeParse({ from: 3, to: 2 }))).toEqual([
			{ path: ['to'], code: 'custom', message: 'from after to' },
		])
		expect(issuesOf(range.safeParse({ from: 'x', to: 2 })).map((issue) => issue.code)).toEqual([
			'invalid_type',
		])
	})

	it('fails unknown keys on a strict object and removes them on a strip object', () => {
		const schema = k.object({ a: k.string() })
		expect(issuesOf(schema.safeParse({ a: 'x', b: 1, c: 2 }))).toEqual([
			{ path: ['b'], code: 'unrecognized_key', message: 'Unrecognized key: "b"' },
			{ path: ['c'], code: 'unrecognized_key', message: 'Unrecognized key: "c"' },
		])
		const strip = schema.strip()
		expect(strip.parse({ a: 'x', b: 1 })).toEqual({ a: 'x' })
		expect(strip.validator).toBe(schema.validator)
	})

	it('throws the KTD6 ConvexError from parse and returns issues from safeParse', () => {
		const schema = k.object({ a: k.string() })
		const result = schema.safeParse({})
		expect(issuesOf(result)).toEqual([
			{
				path: ['a'],
				code: 'invalid_type',
				message: 'Invalid input: expected string, received undefined',
			},
		])
		let caught: unknown
		try {
			schema.parse({})
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(KValidationError)
		expect(caught).toBeInstanceOf(ConvexError)
		// SAFETY: checked to be a KValidationError above.
		expect((caught as KValidationError).data).toEqual({
			code: 'VALIDATION',
			issues: result.success ? [] : result.issues,
		})
	})

	it('compiles an empty plan for a schema with no declared behaviour and returns the input', () => {
		const plain = k.object({
			a: k.string(),
			b: k.array(k.union([k.number(), k.null()])),
			c: k.id('users'),
		})
		const value = { a: 'x', b: [1, null], c: 'id' }
		expect(hasDeclaredBehaviour(plain)).toBe(false)
		expect(runDeclared(plain, value)).toBe(value)
		expect(plain.native).toBeUndefined()
		expect(plain.parse(value)).toBe(value)
	})

	it('runs only declared paths at the boundary', () => {
		const schema = k.object({
			a: k.string(),
			b: k.string().trim(),
			c: k.number().default(1),
			nested: k.object({ keep: k.string(), n: k.int() }),
		})
		const value = { a: 'x', b: ' y ', nested: { keep: 'k', n: 2 } }
		expect(hasDeclaredBehaviour(schema)).toBe(true)
		const out = runDeclared(schema, value)
		expect(out).toEqual({ a: 'x', b: 'y', c: 1, nested: { keep: 'k', n: 2 } })
		// SAFETY: runDeclared returns this object schema's output shape.
		expect((out as { nested: object }).nested).toBe(value.nested)
		expect(() => runDeclared(schema, { ...value, nested: { keep: 'k', n: 1.5 } })).toThrow(
			KValidationError,
		)
	})

	it('reports whether a transform or pipe sits in the tree', () => {
		expect(containsTransform(k.object({ a: k.string().trim() }))).toBe(false)
		expect(containsTransform(k.object({ a: k.array(k.string().transform((s) => s.length)) }))).toBe(
			true,
		)
		expect(containsTransform(k.string().pipe(k.string()))).toBe(true)
		expect(containsTransform(k.string().default('x'))).toBe(false)
	})

	it('validates record keys and values', () => {
		const schema = k.record(k.string().min(2), k.number().int())
		expect(schema.parse({ ab: 1 })).toEqual({ ab: 1 })
		expect(
			issuesOf(schema.safeParse({ a: 1, cd: 1.5 })).map((issue) => [issue.path, issue.code]),
		).toEqual([
			[['a'], 'too_small'],
			[['cd'], 'not_integer'],
		])
		expect(k.record(k.string().trim(), k.string()).parse({ ' a ': 'x' })).toEqual({ a: 'x' })
		expect(issuesOf(k.record(k.string(), k.number()).safeParse([]))[0].code).toBe('invalid_type')
	})

	it('dispatches a discriminated union on its key and rejects an unknown discriminator', () => {
		const figure = k.discriminatedUnion('kind', [
			k.object({ kind: k.literal('circle'), radius: k.number().min(0) }),
			k.object({ kind: k.enum(['square', 'rect']), side: k.number() }),
		])
		expect(figure.parse({ kind: 'rect', side: 2 })).toEqual({ kind: 'rect', side: 2 })
		expect(issuesOf(figure.safeParse({ kind: 'circle', radius: -1 }))).toEqual([
			{ path: ['radius'], code: 'too_small', message: expect.any(String) },
		])
		expect(issuesOf(figure.safeParse({ kind: 'oval' }))).toEqual([
			{ path: ['kind'], code: 'invalid_union', message: expect.any(String) },
		])
	})

	it('tries union members in order and reports invalid_union when none match', () => {
		const schema = k.union([k.string().trim().min(1), k.number()])
		expect(schema.parse(' a ')).toBe('a')
		expect(schema.parse(2)).toBe(2)
		expect(issuesOf(schema.safeParse(' '))).toEqual([
			{ path: [], code: 'invalid_union', message: 'Invalid input: no union member matched' },
		])
	})

	it('checks int64, bytes, json and any', () => {
		expect(k.int64().parse(1n)).toBe(1n)
		expect(issuesOf(k.int64().safeParse(1))[0].code).toBe('invalid_type')
		const buffer = new ArrayBuffer(2)
		expect(k.bytes().parse(buffer)).toBe(buffer)
		expect(k.bytes().safeParse(new Uint8Array(2)).success).toBe(false)
		expect(k.json().parse({ a: [1, 'x', null, { b: true }] })).toEqual({
			a: [1, 'x', null, { b: true }],
		})
		expect(k.json().safeParse({ a: 1n }).success).toBe(false)
		expect(k.json().safeParse({ a: Number.NaN }).success).toBe(false)
		expect(k.json().safeParse(new Date()).success).toBe(false)
		expect(k.any().parse(1n)).toBe(1n)
		expect(k.any().safeParse(undefined).success).toBe(false)
	})

	it('handles optional and nullable combinations', () => {
		const both = k.string().min(1).optional().nullable()
		expect(both.parse(undefined)).toBeUndefined()
		expect(both.parse(null)).toBeNull()
		expect(both.parse('a')).toBe('a')
		expect(both.safeParse('').success).toBe(false)
		expect(k.string().optional().safeParse(null).success).toBe(false)
		expect(k.string().nullable().safeParse(undefined).success).toBe(false)
		expect(k.object({ a: k.string().optional() }).parse({})).toEqual({})
	})

	it('checks literals and enums', () => {
		expect(issuesOf(k.literal('a').safeParse('b'))[0].code).toBe('invalid_value')
		expect(issuesOf(k.enum(['a', 'b']).safeParse('c'))[0].code).toBe('invalid_value')
		expect(k.enum(['a', 'b']).parse('b')).toBe('b')
	})

	it('does not mutate its input', () => {
		const schema = k
			.object({
				name: k.string().trim(),
				tags: k.array(k.string().toUpperCase()),
				n: k.number().default(1),
			})
			.strip()
		const input = { name: ' a ', tags: ['x'], extra: true }
		const snapshot = structuredClone(input)
		const out = schema.parse(input)
		expect(input).toEqual(snapshot)
		expect(out).toEqual({ name: 'a', tags: ['X'], n: 1 })
		expect(out.tags).not.toBe(input.tags)
	})
})
