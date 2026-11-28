import { NoOp } from 'convex-helpers/server/customFunctions'
import {
	defineSchema,
	queryGeneric,
	type GenericQueryCtx,
	type GenericDataModel,
	type DefaultFunctionArgs,
} from 'convex/server'
import { convexTest } from 'convex-test'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'
import { string as zString } from 'zod/mini'
import { k, KValidationError } from '../src/k'
import { toJsonSchema } from '../src/json-schema'
import { kCustomQuery } from '../src/registration'
import { kTable } from '../src/table'
import { toZod } from '../src/zod'
import { toZod as toClassic } from '../src/zod-classic'

describe('fresh fills and declaration checks', () => {
	it('copies nested default and catch values on every fill', () => {
		for (const schema of [
			k
				.object({ rows: k.array(k.object({ tags: k.array(k.string()) })) })
				.default({ rows: [{ tags: [] }] }),
			k
				.object({ rows: k.array(k.object({ tags: k.array(k.string()) })) })
				.catch({ rows: [{ tags: [] }] }),
		]) {
			schema.parse(undefined).rows[0].tags.push('leak')
			expect(schema.parse(undefined)).toEqual({ rows: [{ tags: [] }] })
		}
	})
	it('calls factories per fill and preserves derived and export behavior', () => {
		let calls = 0
		const field = k.array(k.string()).default(() => {
			calls++
			return []
		})
		expectTypeOf<k.infer<typeof field>>().toEqualTypeOf<string[]>()
		const schema = k.object({ field })
		schema.parse({}).field.push('leak')
		expect(schema.parse({})).toEqual({ field: [] })
		expect(calls).toBe(2)
		expect(toJsonSchema(field)).not.toHaveProperty('default')
		expect(calls).toBe(2)
		expect(schema.partial().parse({})).toEqual({})
		expect(schema.pick('field').parse({})).toEqual({ field: [] })
		for (const convert of [toZod, toClassic]) expect(convert(field).parse(undefined)).toEqual([])
		const caught = k.array(k.string()).catch(() => [])
		expectTypeOf(caught.parse(null)).toEqualTypeOf<string[]>()
		expect(caught.parse(null)).not.toBe(caught.parse(null))
	})
	it('fills fresh table insert fields and registered args', async () => {
		const field = k.array(k.string()).default([])
		const table = kTable('fills', { field })
		table.insertSchema.parse({}).field.push('leak')
		expect(table.insertSchema.parse({})).toEqual({ field: [] })
		expect(table.updateSchema.parse({})).toEqual({})
		const factoryTable = kTable(
			'factoryFills',
			{ field: k.array(k.string()).default(() => []) },
			{ publicFields: ['field'] },
		)
		expect(factoryTable.insertSchema.parse({})).toEqual({ field: [] })
		expect(factoryTable.toPublicDto({})).toMatchObject({ field: [] })
		const query = kCustomQuery(queryGeneric, NoOp)
		const fn = query({
			args: { field },
			handler: (_ctx, args) => {
				const before = [...args.field]
				args.field.push('leak')
				return before
			},
		})
		const t = convexTest(defineSchema({}), { './_generated/server.ts': async () => ({}) })
		// SAFETY: registered functions expose their handler at runtime.
		const registered = retyped<{
			_handler(ctx: GenericQueryCtx<GenericDataModel>, args: DefaultFunctionArgs): Promise<string[]>
		}>(fn)
		expect(await t.run((ctx) => registered._handler(ctx, {}))).toEqual([])
		expect(await t.run((ctx) => registered._handler(ctx, {}))).toEqual([])
	})
	it('accepts truthy refinements and refuses promises clearly', () => {
		expect(
			k
				.string()
				.refine((s) => s.match(/x/))
				.safeParse('x').success,
		).toBe(true)
		expect(
			k
				.string()
				.refine(() => 0)
				.safeParse('x').success,
		).toBe(false)
		expect(
			k
				.string()
				.refine(async () => true)
				.safeParse('x'),
		).toMatchObject({ success: false, issues: [{ message: expect.stringMatching(/synchronous/) }] })
	})
	it('rejects foreign fields immediately and names their location', () => {
		for (const field of [zString(), 'oops', undefined]) {
			// @ts-expect-error exercising JavaScript definitions
			expect(() => k.object({ foreign: field })).toThrow(/foreign/)
			// @ts-expect-error exercising JavaScript definitions
			expect(() => k.object({}).extend({ foreign: field })).toThrow(/foreign/)
			// @ts-expect-error exercising JavaScript definitions
			expect(() => k.array(field)).toThrow(/element/)
			// @ts-expect-error exercising JavaScript definitions
			expect(() => k.record(k.string(), field)).toThrow(/value/)
			// @ts-expect-error exercising JavaScript definitions
			expect(() => k.union([k.string(), field])).toThrow(/1/)
		}
	})
	for (const method of ['pick', 'omit', 'required', 'partial'] as const)
		it(`${method} names an unknown key at definition`, () => {
			// @ts-expect-error exercising JavaScript definitions
			expect(() => k.object({ a: k.string() })[method]('missing')).toThrow(/missing/)
		})
	it('keeps an application validation error name and stack', () => {
		try {
			k.string().parse(1)
		} catch (error) {
			expect(error).toBeInstanceOf(KValidationError)
			expect(error).toMatchObject({
				name: 'KValidationError',
				stack: expect.stringMatching(/\bat\b/),
				data: { code: 'VALIDATION' },
			})
		}
	})
	it('counts string code points after normalising', () => {
		expect(k.string().max(1).parse('😀')).toBe('😀')
		expect(k.string().min(2).safeParse('😀').success).toBe(false)
		expect(k.string().length(1).trim().parse(' 😀 ')).toBe('😀')
		expect(k.string().length(2).parse('😀a')).toBe('😀a')
	})
	it('carries record key rules through both Zod converters', () => {
		for (const convert of [toZod, toClassic]) {
			const schema = convert(k.record(k.string(), k.number()))
			for (const key of ['_x', '$x', 'é', 'x'.repeat(1025)])
				expect(schema.safeParse({ [key]: 1 }).success).toBe(false)
			expect(schema.parse({ x: 1 })).toEqual({ x: 1 })
		}
	})
	it('rejects NaN bounds at declaration', () => {
		for (const schema of [k.number(), k.int(), k.string(), k.array(k.string())]) {
			expect(() => schema.min(NaN)).toThrow(/bound/)
			expect(() => schema.max(NaN)).toThrow(/bound/)
		}
		expect(() => k.string().length(NaN)).toThrow(/bound/)
	})
	it('checks array bounds before checking elements', () => {
		let calls = 0
		const schema = k
			.array(
				k.string().refine(() => {
					calls++
					return true
				}),
			)
			.max(2)
		expect(schema.safeParse(['a', 'b', 'c']).success).toBe(false)
		expect(calls).toBe(0)
	})
	it('exports distinct enum literals', () => {
		expect(toJsonSchema(k.enum(['a', 'a']))).toMatchObject({ enum: ['a'] })
	})
})

function retyped<T>(value: { isConvexFunction: true }): T {
	// SAFETY: the runtime Convex builder carries its internal handler method.
	return value as T
}

describe('fills and declaration guards across copies and cycles', () => {
	it('copies a default that contains itself without recursing forever', () => {
		// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the test builds a self-referencing value.
		const value: Record<string, unknown> = {}
		value.self = value
		const filled = k.any().default(value).parse(undefined)
		expect(filled).not.toBe(value)
		expect(filled.self).toBe(filled)
	})

	it('accepts a schema record from another copy of the package as a field', () => {
		// SAFETY: the declaration guard takes any value at runtime; these stand in for untyped callers.
		const field = (value: unknown) => () => k.object({ a: value as never })
		// A second installed copy builds records of another class with the same shape.
		expect(field({ op: 'string', prev: undefined, native: undefined })).not.toThrow()
		expect(field(k.string())).not.toThrow()
		expect(field('oops')).toThrow('must be a k schema')
		expect(field({ parse() {} })).toThrow('must be a k schema')
	})
})
