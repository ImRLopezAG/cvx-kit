import { describe, expect, it } from 'vitest'
import { k } from '../src/k'
import { toJsonSchema } from '../src/json-schema'

describe('JSON Schema converter forms', () => {
	it('exports scalar checks and never', () => {
		expect(toJsonSchema(k.ipv4())).toMatchObject({ format: 'ipv4', pattern: expect.any(String) })
		expect(toJsonSchema(k.ipv6())).toEqual({ type: 'string', format: 'ipv6' })
		expect(toJsonSchema(k.uuid())).toMatchObject({ format: 'uuid', pattern: expect.any(String) })
		expect(toJsonSchema(k.number().gt(0).lt(1).multipleOf(0.05))).toEqual({
			type: 'number',
			exclusiveMinimum: 0,
			exclusiveMaximum: 1,
			multipleOf: 0.05,
		})
		expect(toJsonSchema(k.never())).toEqual({ not: {} })
	})
	it('exports fixed, rest and empty tuples in both dialects', () => {
		expect(toJsonSchema(k.tuple([k.string(), k.number()]))).toEqual({
			type: 'array',
			prefixItems: [{ type: 'string' }, { type: 'number' }],
			minItems: 2,
			maxItems: 2,
			items: false,
		})
		expect(toJsonSchema(k.tuple([], k.boolean()))).toEqual({
			type: 'array',

			minItems: 0,
			items: { type: 'boolean' },
		})
		expect(toJsonSchema(k.tuple([]))).toMatchObject({ minItems: 0, maxItems: 0, items: false })
		expect(
			k.tuple([k.string()], k.number())['~standard'].jsonSchema.input({ target: 'draft-07' }),
		).toMatchObject({
			items: [{ type: 'string' }],
			additionalItems: { type: 'number' },
			minItems: 1,
		})
	})
	it('discovers repeated tuple slots and output shapes', () => {
		const child = k.object({ x: k.string() })
		expect(toJsonSchema(k.tuple([child], child), { refs: true })).toMatchObject({
			prefixItems: [{ $ref: '#/$defs/s0' }],
			items: { $ref: '#/$defs/s0' },
			$defs: { s0: toJsonSchema(child) },
		})
		expect(toJsonSchema(k.tuple([k.string().pipe(k.number())]), { io: 'output' })).toMatchObject({
			prefixItems: [{ type: 'number' }],
		})
	})
	it('reuses repeated tuples and emits fixed tuple draft-07 keywords', () => {
		const tuple = k.tuple([k.string()])
		expect(toJsonSchema(k.object({ a: tuple, b: tuple }), { refs: true })).toMatchObject({
			properties: { a: { $ref: '#/$defs/s0' }, b: { $ref: '#/$defs/s0' } },
			$defs: { s0: toJsonSchema(tuple) },
		})
		const fixed = tuple['~standard'].jsonSchema.input({ target: 'draft-07' })
		expect(fixed).toMatchObject({
			items: [{ type: 'string' }],
			minItems: 1,
			maxItems: 1,
			additionalItems: false,
		})
		expect(fixed).not.toHaveProperty('prefixItems')
	})
	it('describes parse unknown keys through nested refs and explicit policies', () => {
		const child = k.object({ x: k.string() })
		const schema = k.object({
			a: child,
			b: child,
			strict: child.strict(),
			strip: child.strip(),
			loose: child.loose(),
		})
		const input = toJsonSchema(schema, { unknownKeys: 'parse', refs: true })
		expect(input).not.toHaveProperty('additionalProperties')
		expect(input.$defs?.s0).not.toHaveProperty('additionalProperties')
		expect(input.properties?.strict.additionalProperties).toBe(false)
		expect(input.properties?.strip).not.toHaveProperty('additionalProperties')
		expect(input.properties?.loose.additionalProperties).toBe(true)
		expect(toJsonSchema(child).additionalProperties).toBe(false)
		expect(toJsonSchema(child, { unknownKeys: 'parse', io: 'output' }).additionalProperties).toBe(
			false,
		)
		expect(
			toJsonSchema(child.strip(), { unknownKeys: 'parse', io: 'output' }).additionalProperties,
		).toBe(false)
		expect(
			toJsonSchema(child.loose(), { unknownKeys: 'parse', io: 'output' }).additionalProperties,
		).toBe(true)
	})
	it.each(['draft-07', 'draft-2020-12'])(
		'supports Standard libraryOptions for %s and validates values',
		(target) => {
			const schema = k.object({ x: k.string() })
			expect(
				schema['~standard'].jsonSchema.input({ target, libraryOptions: { unknownKeys: 'parse' } }),
			).not.toHaveProperty('additionalProperties')
			expect(
				schema['~standard'].jsonSchema.output({ target, libraryOptions: { unknownKeys: 'parse' } }),
			).toHaveProperty('additionalProperties', false)
			expect(() =>
				schema['~standard'].jsonSchema.input({ target, libraryOptions: { unknownKeys: 'other' } }),
			).toThrow(/unknownKeys/)
		},
	)
	it('keeps catch input unconstrained and does not execute factories', () => {
		let calls = 0
		const schema = k.object({
			x: k
				.string()
				.min(3)
				.catch(() => {
					calls++
					return 'x'
				}),
			y: k.string().catch('x').nullable(),
			z: k.string().default(() => {
				calls++
				return 'z'
			}),
		})
		const input = toJsonSchema(schema, { unknownKeys: 'parse' })
		expect(input.properties?.x).toEqual({})
		expect(input.properties?.y).toEqual({ anyOf: [{}, { type: 'null' }] })
		expect(input.required).toBeUndefined()
		expect(toJsonSchema(schema, { io: 'output', unknownKeys: 'parse' }).properties?.x).toEqual({
			type: 'string',
		})
		expect(calls).toBe(0)
	})
	it('retains descriptive bytes and integer JSON forms without a decoder', () => {
		expect(toJsonSchema(k.bytes())).toEqual({ type: 'string', contentEncoding: 'base64' })
		expect(k.bytes().safeParse('AA==').success).toBe(false)
		expect(k.bytes().safeParse(new ArrayBuffer(1)).success).toBe(true)
		expect(toJsonSchema(k.int64())).toEqual({ type: 'integer' })
		expect(k.int64().safeParse(1).success).toBe(false)
		expect(k.int64().safeParse(1n).success).toBe(true)
	})
})

describe('tuple and multiple edge cases', () => {
	it('never emits an empty positional list', () => {
		expect(toJsonSchema(k.tuple([]))).toEqual({
			type: 'array',
			items: false,
			minItems: 0,
			maxItems: 0,
		})
		expect(toJsonSchema(k.tuple([], k.string()))).toEqual({
			type: 'array',
			items: { type: 'string' },
			minItems: 0,
		})
	})

	it('keeps every divisor of a number with two multiples', () => {
		expect(toJsonSchema(k.number().multipleOf(2).multipleOf(3))).toEqual({
			type: 'number',
			multipleOf: 2,
			allOf: [{ multipleOf: 3 }],
		})
	})
})
