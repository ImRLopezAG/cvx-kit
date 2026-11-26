import { describe, expect, it } from 'vitest'
import { toJsonSchema } from '../src/json-schema'
import { k } from '../src/k'

describe('toJsonSchema', () => {
	it('carries constraints and the input-side required list', () => {
		const schema = k.object({
			name: k.string().trim().min(1).max(80),
			code: k.string().regex(/^[A-Z]{3}$/),
			status: k.enum(['open', 'done']).default('open'),
			note: k.string().optional(),
			count: k.int().min(0).max(10),
			price: k.number().min(0),
			tags: k.array(k.string()).min(1).max(5),
			exact: k.string().length(2),
		})
		expect(toJsonSchema(schema)).toEqual({
			type: 'object',
			properties: {
				name: { type: 'string', minLength: 1, maxLength: 80 },
				code: { type: 'string', pattern: '^[A-Z]{3}$' },
				status: { type: 'string', enum: ['open', 'done'], default: 'open' },
				note: { type: 'string' },
				count: { type: 'integer', minimum: 0, maximum: 10 },
				price: { type: 'number', minimum: 0 },
				tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
				exact: { type: 'string', minLength: 2, maxLength: 2 },
			},
			required: ['name', 'code', 'count', 'price', 'tags', 'exact'],
			additionalProperties: false,
		})
	})

	it('emits descriptions, ids as strings, dates with formats and the $schema option', () => {
		const schema = k
			.object({
				owner: k.id('users').describe('The owner'),
				due: k.isoDate(),
				at: k.isoDateTime().optional(),
				when: k.timestamp(),
			})
			.describe('A task')
		expect(toJsonSchema(schema, { $schema: true })).toEqual({
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			description: 'A task',
			properties: {
				owner: { type: 'string', description: 'The owner' },
				due: { type: 'string', format: 'date' },
				at: { type: 'string', format: 'date-time' },
				when: { type: 'integer', minimum: 0, maximum: 253_402_300_799_999 },
			},
			required: ['owner', 'due', 'when'],
			additionalProperties: false,
		})
	})

	it('emits the input schema of a transform or pipe', () => {
		const size = k
			.string()
			.min(1)
			.transform((value) => value.length)
			.pipe(k.number().max(3))
		expect(toJsonSchema(k.object({ size }))).toEqual({
			type: 'object',
			properties: { size: { type: 'string', minLength: 1 } },
			required: ['size'],
			additionalProperties: false,
		})
		expect(toJsonSchema(k.isoDate().toTimestamp())).toEqual({ type: 'string', format: 'date' })
	})

	it('emits unions, discriminated unions, nullable, records and literals', () => {
		expect(toJsonSchema(k.union([k.string(), k.number()]))).toEqual({
			anyOf: [{ type: 'string' }, { type: 'number' }],
		})
		const figure = k.discriminatedUnion('kind', [
			k.object({ kind: k.literal('circle'), r: k.number() }),
			k.object({ kind: k.literal('dot') }),
		])
		expect(toJsonSchema(figure)).toEqual({
			oneOf: [
				{
					type: 'object',
					properties: { kind: { type: 'string', const: 'circle' }, r: { type: 'number' } },
					required: ['kind', 'r'],
					additionalProperties: false,
				},
				{
					type: 'object',
					properties: { kind: { type: 'string', const: 'dot' } },
					required: ['kind'],
					additionalProperties: false,
				},
			],
		})
		expect(toJsonSchema(k.string().min(2).nullable().describe('n'))).toEqual({
			anyOf: [{ type: 'string', minLength: 2 }, { type: 'null' }],
			description: 'n',
		})
		expect(toJsonSchema(k.record(k.id('users'), k.boolean()))).toEqual({
			type: 'object',
			propertyNames: { type: 'string' },
			additionalProperties: { type: 'boolean' },
		})
		expect(toJsonSchema(k.literal(3))).toEqual({ type: 'number', const: 3 })
		expect(toJsonSchema(k.json())).toEqual({})
	})

	it('uses the strongest of repeated bounds and joins repeated patterns', () => {
		expect(toJsonSchema(k.number().min(10).min(0))).toEqual({ type: 'number', minimum: 10 })
		expect(toJsonSchema(k.number().max(3).max(9).max(5))).toEqual({ type: 'number', maximum: 3 })
		expect(toJsonSchema(k.string().min(2).length(4).max(10).min(1))).toEqual({
			type: 'string',
			minLength: 4,
			maxLength: 4,
		})
		expect(toJsonSchema(k.array(k.number()).max(4).max(2).min(1))).toEqual({
			type: 'array',
			items: { type: 'number' },
			minItems: 1,
			maxItems: 2,
		})
		expect(toJsonSchema(k.timestamp().min(-5))).toEqual({
			type: 'integer',
			minimum: 0,
			maximum: 253_402_300_799_999,
		})
		expect(toJsonSchema(k.string().regex(/^a/).regex(/b$/).regex(/x/))).toEqual({
			type: 'string',
			pattern: '^a',
			allOf: [{ pattern: 'b$' }, { pattern: 'x' }],
		})
	})

	it('keeps strip objects closed and omits partial fields from required', () => {
		const schema = k.object({ a: k.string(), b: k.number().default(1) })
		// A stripping object accepts unknown keys on input and emits none on output.
		expect('additionalProperties' in toJsonSchema(schema.strip())).toBe(false)
		expect(toJsonSchema(schema.strip(), { io: 'output' }).additionalProperties).toBe(false)
		expect(toJsonSchema(schema.partial()).required).toBeUndefined()
		expect(toJsonSchema(schema).required).toEqual(['a'])
	})
})

describe('toJsonSchema io: output', () => {
	const schema = k.object({
		name: k.string(),
		status: k.enum(['open', 'done']).default('open'),
		note: k.string().optional(),
		filled: k.number().default(1).optional(),
		count: k.string().transform(Number),
		piped: k.string().pipe(k.string().min(2)),
	})

	it('makes defaulted fields required and describes transforms and pipes by their output', () => {
		expect(toJsonSchema(schema, { io: 'output' })).toEqual({
			type: 'object',
			properties: {
				name: { type: 'string' },
				status: { type: 'string', enum: ['open', 'done'], default: 'open' },
				note: { type: 'string' },
				filled: { type: 'number', default: 1 },
				count: {},
				piped: { type: 'string', minLength: 2 },
			},
			required: ['name', 'status', 'filled', 'count', 'piped'],
			additionalProperties: false,
		})
	})

	it('keeps the input side as the default', () => {
		expect(toJsonSchema(schema)).toEqual(toJsonSchema(schema, { io: 'input' }))
		expect(toJsonSchema(schema).required).toEqual(['name', 'count', 'piped'])
		expect(toJsonSchema(schema.partial(), { io: 'output' }).required).toBeUndefined()
	})
})
