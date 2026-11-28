import { readFileSync } from 'node:fs'
import { v } from 'convex/values'
import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { describe, expect, it } from 'vitest'
import { k } from '../src/k'
import { k as rootK } from '../src/index'
import type { KType } from '../src/k/types'

function nativeJson(validator: GenericValidator): string {
	// SAFETY: Convex validators expose the json getter at runtime; declarations mark it internal.
	return JSON.stringify((validator as GenericValidator & { readonly json: ValidatorJSON }).json)
}

function expectNative(schema: KType, expected: GenericValidator) {
	expect(nativeJson(schema.validator)).toBe(nativeJson(expected))
	expect(schema.validator.isOptional).toBe(expected.isOptional)
}

describe('k kinds', () => {
	it('is exported from the root entry and cvx-kit/k', () => {
		expect(rootK).toBe(k)
	})

	it('builds each kind as its hand-written native validator', () => {
		expectNative(k.string(), v.string())
		expectNative(k.number(), v.number())
		expectNative(k.int(), v.number())
		expectNative(k.int64(), v.int64())
		expectNative(k.boolean(), v.boolean())
		expectNative(k.null(), v.null())
		expectNative(k.bytes(), v.bytes())
		expectNative(k.any(), v.any())
		expectNative(
			k.json(),
			v.union(
				v.string(),
				v.number(),
				v.boolean(),
				v.null(),
				v.array(v.any()),
				v.record(v.string(), v.any()),
			),
		)
		expectNative(k.literal('a'), v.literal('a'))
		expectNative(k.literal(1n), v.literal(1n))
		expectNative(k.enum(['a', 'b']), v.union(v.literal('a'), v.literal('b')))
		expectNative(k.id('users'), v.id('users'))
		expectNative(k.array(k.int64()), v.array(v.int64()))
		expectNative(k.object({ a: k.bytes() }), v.object({ a: v.bytes() }))
		expectNative(k.union([k.string(), k.null()]), v.union(v.string(), v.null()))
		expectNative(k.string().optional(), v.optional(v.string()))
		expectNative(k.string().nullable(), v.nullable(v.string()))
		expectNative(k.string().default('x'), v.optional(v.string()))
	})

	it('matches the v1 parity snapshot for a one-value enum and a JSON field', () => {
		const snapshot = JSON.parse(
			readFileSync(new URL('./parity/v1-tables.snapshot.json', import.meta.url), 'utf8'),
		)
		const stored = (name: string, field: string) =>
			snapshot[name].table.documentType.value[field].fieldType
		expect(JSON.parse(nativeJson(k.enum(['only']).validator))).toEqual(stored('scalars', 'enumOne'))
		expect(JSON.parse(nativeJson(k.json().validator))).toEqual(stored('opaque', 'jsonValue'))
	})

	it('builds records keyed by string and by id', () => {
		expectNative(k.record(k.string(), k.number()), v.record(v.string(), v.number()))
		expectNative(
			k.record(k.id('users'), k.object({ role: k.enum(['admin', 'member']) })),
			v.record(v.id('users'), v.object({ role: v.union(v.literal('admin'), v.literal('member')) })),
		)
		expectNative(k.record(k.string(), k.number().min(1)), v.record(v.string(), v.number()))
	})

	it('builds a discriminated union as a native union of objects and keeps its key', () => {
		const figure = k.discriminatedUnion('kind', [
			k.object({ kind: k.literal('circle'), radius: k.number() }),
			k.object({ kind: k.literal('square'), side: k.number() }),
		])
		expectNative(
			figure,
			v.union(
				v.object({ kind: v.literal('circle'), radius: v.number() }),
				v.object({ kind: v.literal('square'), side: v.number() }),
			),
		)
		expect(figure.discriminator).toBe('kind')
		expect(figure.options).toHaveLength(2)
	})

	it('exposes enum options and unwraps wrappers to the inner schema', () => {
		const status = k.enum(['open', 'done'])
		expect(status.options).toEqual(['open', 'done'])
		expect(status.refine(() => true).options).toBe(status.options)
		const name = k.string().min(1)
		expect(name.optional().unwrap()).toBe(name)
		expect(name.nullable().unwrap()).toBe(name)
		expect(name.default('x').unwrap()).toBe(name)
		expect(
			name
				.optional()
				.refine(() => true)
				.unwrap(),
		).toBe(name)
	})

	it('builds an output-side validator where a default is required', () => {
		const schema = k.object({
			status: k.enum(['open', 'done']).default('open'),
			note: k.string().optional(),
			tags: k.array(k.object({ n: k.number().default(0) })),
		})
		expectNative(
			schema,
			v.object({
				status: v.optional(v.union(v.literal('open'), v.literal('done'))),
				note: v.optional(v.string()),
				tags: v.array(v.object({ n: v.optional(v.number()) })),
			}),
		)
		expect(nativeJson(schema.outputValidator)).toBe(
			nativeJson(
				v.object({
					status: v.union(v.literal('open'), v.literal('done')),
					note: v.optional(v.string()),
					tags: v.array(v.object({ n: v.number() })),
				}),
			),
		)
		expect(schema.outputValidator).toBe(schema.outputValidator)
		expect(schema.outputNative).toBe(schema.outputValidator)
	})

	it('shares the input validator as the output validator when nothing differs', () => {
		const schema = k.object({ a: k.string().trim().min(1), b: k.array(k.number()).optional() })
		expect(schema.outputValidator).toBe(schema.validator)
		const field = k.string().optional()
		expect(field.outputValidator).toBe(field.validator)
	})

	it('keeps an optional over a default optional on the output side', () => {
		expect(k.string().default('x').optional().outputValidator.isOptional).toBe('optional')
		expect(k.string().optional().default('x').outputValidator.isOptional).toBe('required')
		expectNative(k.string().default('x').nullable(), v.optional(v.nullable(v.string())))
		expect(nativeJson(k.string().default('x').nullable().outputValidator)).toBe(
			nativeJson(v.nullable(v.string())),
		)
	})

	it('uses the input schema natively for transform and pipe, and any or the target on output', () => {
		const length = k.string().transform((value) => value.length)
		expectNative(length, v.string())
		expect(nativeJson(length.outputValidator)).toBe(nativeJson(v.any()))
		const piped = k
			.string()
			.transform((value) => Number(value))
			.pipe(k.number().int())
		expectNative(piped, v.string())
		expect(nativeJson(piped.outputValidator)).toBe(nativeJson(v.number()))
		const field = k.object({ size: length.optional() })
		expectNative(field, v.object({ size: v.optional(v.string()) }))
		expect(nativeJson(field.outputValidator)).toBe(
			nativeJson(v.object({ size: v.optional(v.any()) })),
		)
	})

	it('builds nothing at declaration', () => {
		const schema = k.record(k.string(), k.object({ a: k.string().default('') }))
		expect(schema.native).toBeUndefined()
		expect(schema.outputNative).toBeUndefined()
		expect(schema.plan).toBeUndefined()
	})
})
