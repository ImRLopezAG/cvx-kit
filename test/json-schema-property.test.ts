/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- A JSON Schema validator classifies arbitrary JSON values by representation. */
import { describe, expect, it } from 'vite-plus/test'
import { toJsonSchema, type JsonSchema } from '../src/json-schema'
import { k } from '../src/k'
import type { KType } from '../src/k/types'

/**
 * A minimal JSON Schema (2020-12) validator for the keywords `toJsonSchema` emits. No validator is
 * installed in the repo, and this one only needs that subset. `format` and `contentEncoding` are
 * annotations in 2020-12 and are not asserted; `default` and `description` are annotations.
 */
function valid(schema: JsonSchema, value: unknown, root: JsonSchema = schema): boolean {
	if (schema.$ref !== undefined) {
		const name = schema.$ref.slice(schema.$ref.lastIndexOf('/') + 1)
		const target = root.$defs?.[name]
		return target !== undefined && valid(target, value, root)
	}
	if (schema.type !== undefined && !hasType(schema.type, value)) return false
	if (schema.const !== undefined && value !== schema.const) return false
	if (schema.enum !== undefined && !schema.enum.some((member) => member === value)) return false
	if (typeof value === 'string') {
		if (schema.minLength !== undefined && [...value].length < schema.minLength) return false
		if (schema.maxLength !== undefined && [...value].length > schema.maxLength) return false
		if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) return false
	}
	if (typeof value === 'number') {
		if (schema.minimum !== undefined && value < schema.minimum) return false
		if (schema.maximum !== undefined && value > schema.maximum) return false
		if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false
		if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return false
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) return false
		if (schema.maxItems !== undefined && value.length > schema.maxItems) return false
		const items = schema.items
		if (items !== undefined && !value.every((item) => valid(items, item, root))) return false
	}
	if (isObject(value)) {
		const keys = Object.keys(value)
		if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false
		const properties = schema.properties ?? {}
		for (const key of keys) {
			if (Object.hasOwn(properties, key)) {
				if (!valid(properties[key], value[key], root)) return false
			} else if (schema.additionalProperties === false) return false
			else if (
				schema.additionalProperties !== undefined &&
				schema.additionalProperties !== true &&
				!valid(schema.additionalProperties, value[key], root)
			)
				return false
			const names = schema.propertyNames
			if (names !== undefined && !valid(names, key, root)) return false
		}
	}
	if (schema.allOf !== undefined && !schema.allOf.every((member) => valid(member, value, root)))
		return false
	if (schema.anyOf !== undefined && !schema.anyOf.some((member) => valid(member, value, root)))
		return false
	if (
		schema.oneOf !== undefined &&
		schema.oneOf.filter((member) => valid(member, value, root)).length !== 1
	)
		return false
	return true
}

function hasType(type: NonNullable<JsonSchema['type']>, value: unknown): boolean {
	switch (type) {
		case 'null':
			return value === null
		case 'array':
			return Array.isArray(value)
		case 'object':
			return isObject(value)
		case 'integer':
			return Number.isInteger(value)
		case 'number':
			return typeof value === 'number' && Number.isFinite(value)
		default:
			return typeof value === type
	}
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface Case {
	readonly name: string
	readonly schema: KType & { safeParse(input: unknown): { success: boolean; data?: unknown } }
	readonly samples: readonly unknown[]
}

const shared = k.object({ a: k.string() })

// Kinds whose values are not JSON (int64, bytes) have no JSON Schema sample and are left out.
const cases: readonly Case[] = [
	{ name: 'string', schema: k.string(), samples: ['', 'x', 1, null] },
	{ name: 'string checks', schema: k.string().min(2).max(3), samples: ['a', 'ab', 'abcd'] },
	{ name: 'string length', schema: k.string().length(2), samples: ['ab', 'a'] },
	{
		name: 'regex',
		schema: k
			.string()
			.regex(/^a+$/)
			.regex(/^.{2}$/),
		samples: ['aa', 'a', 'b'],
	},
	{ name: 'trim', schema: k.string().trim().min(1), samples: [' a ', '  ', 'a'] },
	{
		name: 'lower',
		schema: k
			.string()
			.toLowerCase()
			.regex(/^[a-z]+$/),
		samples: ['AB', 'ab', '1'],
	},
	{ name: 'number', schema: k.number(), samples: [1, 1.5, -1, 'x'] },
	{ name: 'number finite', schema: k.number().finite(), samples: [1, 'x'] },
	{ name: 'number bounds', schema: k.number().min(1).max(3), samples: [0, 1, 3, 4] },
	{ name: 'positive', schema: k.number().positive().negative(), samples: [0, 1, -1] },
	{ name: 'nonnegative', schema: k.number().nonnegative().nonpositive(), samples: [0, 1] },
	{ name: 'int', schema: k.int(), samples: [1, 1.5, 2 ** 60] },
	{ name: 'safe', schema: k.number().safe(), samples: [1, 2 ** 60, 1.5] },
	{ name: 'boolean', schema: k.boolean(), samples: [true, 0] },
	{ name: 'null', schema: k.null(), samples: [null, 0] },
	{ name: 'any', schema: k.any(), samples: [1, 'x', null, { a: [1] }] },
	{ name: 'json', schema: k.json(), samples: [1, 'x', null, [{ a: 1 }]] },
	{
		name: 'jsonObject',
		schema: k.jsonObject(),
		samples: [{ a: 1 }, { _id: 'x' }, { $ref: 1 }, { '': 1 }, { é: 1 }, { a: { $b: 1 } }, []],
	},
	{ name: 'isoDate', schema: k.isoDate(), samples: ['2026-01-02', '2026-13-01'] },
	{ name: 'isoDateTime', schema: k.isoDateTime(), samples: ['2026-01-02T00:00:00Z', 'x'] },
	{ name: 'timestamp', schema: k.timestamp(), samples: [0, -1, 1.5, 1e20] },
	{ name: 'literal', schema: k.literal('a'), samples: ['a', 'b'] },
	{ name: 'number literal', schema: k.literal(2), samples: [2, 3] },
	{ name: 'enum', schema: k.enum(['a', 'b']), samples: ['a', 'c'] },
	{ name: 'id', schema: k.id('users'), samples: ['users1', 1] },
	{
		name: 'array',
		schema: k.array(k.number()).min(1).max(2),
		samples: [[], [1], [1, 2, 3], ['x']],
	},
	{ name: 'array length', schema: k.array(k.string()).length(1), samples: [['a'], []] },
	{
		name: 'object',
		schema: k.object({ a: k.string(), b: k.number().optional() }),
		samples: [{ a: 'x' }, { a: 'x', b: 1 }, { b: 1 }, { a: 'x', c: 1 }],
	},
	{
		name: 'object default',
		schema: k.object({ a: k.string().default('d'), b: k.number().nullable() }),
		samples: [{ b: null }, { a: 'x', b: 1 }, {}],
	},
	{ name: 'strip', schema: k.object({ a: k.string() }).strip(), samples: [{ a: 'x', b: 1 }] },
	{ name: 'loose', schema: k.looseObject({ a: k.string() }), samples: [{ a: 'x', b: 1 }] },
	{
		name: 'partial and required',
		schema: k.object({ a: k.string(), b: k.number().optional() }).partial().required('b'),
		samples: [{ b: 1 }, {}, { a: 'x', b: 1 }],
	},
	{ name: 'record', schema: k.record(k.string(), k.number()), samples: [{ a: 1 }, { a: 'x' }] },
	{
		name: 'finite record',
		schema: k.record(k.enum(['x', 'y']), k.number()),
		samples: [{ x: 1, y: 2 }, { x: 1 }],
	},
	{
		name: 'partialRecord',
		schema: k.partialRecord(k.enum(['x', 'y']), k.number()),
		samples: [{ x: 1 }, {}],
	},
	{ name: 'union', schema: k.union([k.string(), k.number().min(5)]), samples: ['a', 6, 1] },
	{
		name: 'discriminatedUnion',
		schema: k.discriminatedUnion('kind', [
			k.object({ kind: k.literal('a'), n: k.number() }),
			k.object({ kind: k.enum(['b', 'c']) }),
		]),
		samples: [{ kind: 'a', n: 1 }, { kind: 'c' }, { kind: 'd' }],
	},
	{
		name: 'nullable optional',
		schema: k.object({ a: k.string().min(1).nullable().optional() }),
		samples: [{}, { a: null }, { a: '' }],
	},
	{ name: 'describe', schema: k.string().describe('text'), samples: ['a'] },
	{
		name: 'catch',
		schema: k.object({ a: k.number().min(5).catch(0) }),
		samples: [{}, { a: 1 }, { a: 6 }],
	},
	{
		name: 'transform',
		schema: k.object({
			a: k
				.string()
				.optional()
				.transform((value) => value),
		}),
		samples: [{}, { a: 'x' }],
	},
	{
		name: 'transform type',
		schema: k.string().transform((value) => value.length),
		samples: ['ab'],
	},
	{ name: 'pipe', schema: k.string().nullable().pipe(k.string()), samples: ['a', null] },
	{
		name: 'pipe optional',
		schema: k.object({ a: k.string().optional().pipe(k.string().optional()) }),
		samples: [{}, { a: 'x' }],
	},
	{ name: 'default nullable', schema: k.string().nullable().default('x'), samples: [null, 'a'] },
	{
		name: 'shared refs',
		schema: k.object({ a: shared, b: k.array(shared) }),
		samples: [{ a: { a: 'x' }, b: [{ a: 'y' }] }],
	},
]

describe('toJsonSchema agrees with parse', () => {
	it.each(cases)(
		'$name: values parse accepts validate against the input schema',
		({ schema, samples }) => {
			for (const refs of [false, true]) {
				const json = toJsonSchema(schema, { refs })
				for (const sample of samples)
					if (schema.safeParse(sample).success)
						expect([sample, valid(json, sample)]).toEqual([sample, true])
			}
		},
	)

	it.each(cases)(
		'$name: parsed outputs validate against the output schema',
		({ schema, samples }) => {
			for (const refs of [false, true]) {
				const json = toJsonSchema(schema, { io: 'output', refs })
				for (const sample of samples) {
					const result = schema.safeParse(sample)
					if (result.success)
						expect([result.data, valid(json, result.data)]).toEqual([result.data, true])
				}
			}
		},
	)

	it('jsonObject states the top-level key rule exactly', () => {
		const json = toJsonSchema(k.jsonObject())
		for (const key of ['a', '_id', 'a$', ' ', 'x'.repeat(1024)])
			expect(valid(json, { [key]: 1 })).toBe(true)
		for (const key of ['$ref', '', 'é', 'a\n', 'x'.repeat(1025)])
			expect([key.slice(0, 4), valid(json, { [key]: 1 })]).toEqual([key.slice(0, 4), false])
	})
})
