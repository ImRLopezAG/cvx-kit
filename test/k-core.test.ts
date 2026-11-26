import { v } from 'convex/values'
import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { describe, expect, it } from 'vitest'
import { k } from '../src/k/index'
import type { KType } from '../src/k/types'

function nativeJson(validator: GenericValidator): string {
	// SAFETY: Convex validators expose the json getter at runtime; declarations mark it internal.
	return JSON.stringify((validator as GenericValidator & { readonly json: ValidatorJSON }).json)
}

function expectNative(schema: KType, expected: GenericValidator) {
	expect(nativeJson(schema.validator)).toBe(nativeJson(expected))
	expect(schema.validator.isOptional).toBe(expected.isOptional)
}

describe('k chain records', () => {
	it('leaves a shared base unchanged when chaining from it', () => {
		const base = k.string()
		const min = base.min(1)
		const max = base.max(5)
		expect(base.prev).toBeNull()
		expect(base.op).toBe('string')
		expect(min.prev).toBe(base)
		expect(min.op).toBe('min')
		expect(min.arg).toBe(1)
		expect(max.prev).toBe(base)
		expect(max.arg).toBe(5)
		expect(min).not.toBe(base)
		expectNative(base, v.string())
		expectNative(min, v.string())
		expectNative(max, v.string())
	})

	it('allocates one record per chained call, linked to its predecessor', () => {
		const a = k.string()
		const b = a.trim()
		const c = b.min(1, 'required')
		const d = c.regex(/^x/)
		const e = d.optional()
		expect([e.prev, d.prev, c.prev, b.prev, a.prev]).toEqual([d, c, b, a, null])
		expect(c.message).toBe('required')
		expect(Object.keys(c)).toEqual(Object.keys(a))
		expect(Object.getPrototypeOf(c)).toBe(Object.getPrototypeOf(a))
		expect(a.op).toBe('string')
		expect(b.op).toBe('trim')
	})

	it('does not build the native validator until it is read, then memoises it', () => {
		const schema = k.object({ name: k.string().min(1), tags: k.array(k.string()) })
		expect(schema.native).toBeUndefined()
		const first = schema.validator
		expect(schema.native).toBe(first)
		expect(schema.validator).toBe(first)
	})

	it('shares immutable argument-less roots and their native validator', () => {
		expect(k.string()).toBe(k.string())
		expect(k.int()).not.toBe(k.number())
		const a = k.string().min(1)
		const b = k.string().max(2)
		expect(a.prev).toBe(b.prev)
		expect(a.validator).toBe(b.validator)
		expect(a.validator).toBe(k.string().validator)
		expect(k.string().optional().validator).not.toBe(k.string().validator)
	})

	it('keeps methods on shared prototypes, not on instances', () => {
		const schema = k.number().min(0)
		expect(Object.hasOwn(schema, 'min')).toBe(false)
		expect(Object.hasOwn(schema, 'validator')).toBe(false)
		expect(Object.keys(schema)).toEqual([
			'prev',
			'op',
			'arg',
			'message',
			'native',
			'outputNative',
			'plan',
		])
	})
})

describe('k native validators', () => {
	it('builds scalar factories', () => {
		expectNative(k.string(), v.string())
		expectNative(k.number(), v.number())
		expectNative(k.number().int().min(0).max(10), v.number())
		expectNative(k.int(), v.number())
		expectNative(k.boolean(), v.boolean())
		expectNative(k.null(), v.null())
		expectNative(k.literal('a'), v.literal('a'))
		expectNative(k.literal(3), v.literal(3))
		expectNative(k.literal(true), v.literal(true))
		expectNative(
			k.string().refine((value) => value.length > 0, 'empty'),
			v.string(),
		)
	})

	it('builds an id validator for the named table', () => {
		const schema = k.id('users')
		expectNative(schema, v.id('users'))
		expect(nativeJson(schema.validator)).toBe(JSON.stringify({ type: 'id', tableName: 'users' }))
	})

	it('builds enums as a literal union, and a single-value enum as a one-member union (v1 parity)', () => {
		expectNative(k.enum(['a', 'b', 'c']), v.union(v.literal('a'), v.literal('b'), v.literal('c')))
		expectNative(k.enum(['only']), v.union(v.literal('only')))
	})

	it('builds arrays and unions', () => {
		expectNative(k.array(k.string().min(1)).max(3), v.array(v.string()))
		expectNative(k.union([k.string(), k.number()]), v.union(v.string(), v.number()))
		expectNative(
			k.union([
				k.object({ kind: k.literal('a') }),
				k.object({ kind: k.literal('b'), n: k.number() }),
			]),
			v.union(
				v.object({ kind: v.literal('a') }),
				v.object({ kind: v.literal('b'), n: v.number() }),
			),
		)
	})

	it('builds objects with optional fields', () => {
		expectNative(k.object({ a: k.string().optional() }), v.object({ a: v.optional(v.string()) }))
	})

	it('builds nullable as union(inner, null), matching v.nullable', () => {
		expectNative(k.string().nullable(), v.nullable(v.string()))
		expectNative(
			k.object({ a: k.number().nullable() }),
			v.object({ a: v.union(v.number(), v.null()) }),
		)
		expectNative(k.string().nullable().optional(), v.optional(v.nullable(v.string())))
		expectNative(k.string().optional().nullable(), v.optional(v.nullable(v.string())))
	})

	it('makes a defaulted field optional on the input side', () => {
		expectNative(k.string().default('x'), v.optional(v.string()))
		expectNative(
			k.object({ status: k.enum(['open', 'done']).default('open'), n: k.number() }),
			v.object({
				status: v.optional(v.union(v.literal('open'), v.literal('done'))),
				n: v.number(),
			}),
		)
	})

	it('builds nested objects and reuses field schemas without mutating them', () => {
		const name = k.string().trim().min(1)
		const address = k.object({ city: name, zip: k.string().optional() })
		const user = k.object({
			name,
			address,
			previous: k.array(address).optional(),
			owner: k.id('users'),
			role: k.enum(['admin', 'member']).default('member'),
			deletedAt: k.number().nullable(),
		})
		const addressNative = v.object({ city: v.string(), zip: v.optional(v.string()) })
		expectNative(
			user,
			v.object({
				name: v.string(),
				address: addressNative,
				previous: v.optional(v.array(addressNative)),
				owner: v.id('users'),
				role: v.optional(v.union(v.literal('admin'), v.literal('member'))),
				deletedAt: v.nullable(v.number()),
			}),
		)
		expect(name.op).toBe('min')
		expect(name.prev?.op).toBe('trim')
		expect(address.validator).toBe(address.validator)
	})
})
