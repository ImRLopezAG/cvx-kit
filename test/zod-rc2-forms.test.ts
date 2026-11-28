import { describe, expect, it } from 'vitest'
import { toJSONSchema } from 'zod'
import { k } from '../src/k'
import { toZod } from '../src/zod'
import { toZod as classic } from '../src/zod-classic'

const converters = { mini: toZod, classic }
const forms = [
	{
		name: 'ipv4',
		schema: k.ipv4(),
		inputs: ['127.0.0.1', '0.0.0.0', '01.2.3.4', '256.0.0.1', '1.2.3.4/24', 1],
	},
	{
		name: 'ipv6',
		schema: k.ipv6(),
		inputs: ['::1', '2001:DB8::1', '::ffff:192.0.2.1', 'fe80::1%eth0', ':::', ' ::1', 1],
	},
	{
		name: 'uuid',
		schema: k.uuid(),
		inputs: [
			'550e8400-e29b-41d4-a716-446655440000',
			'00000000-0000-0000-0000-000000000000',
			'ffffffff-ffff-ffff-ffff-ffffffffffff',
			'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
			'550e8400-e29b-91d4-a716-446655440000',
			'550e8400-e29b-41d4-7716-446655440000',
			1,
		],
	},
	{
		name: 'bounds and multiples',
		schema: k.number().gt(-1).lt(1).multipleOf(0.05),
		inputs: [-1, -0.3, 0, 0.3, 0.31, 1, Infinity, NaN],
	},
	{
		name: 'overflow multiple',
		schema: k.number().multipleOf(Number.MIN_VALUE),
		inputs: [0, Number.MIN_VALUE, 1, Number.MAX_VALUE],
	},
	{ name: 'never', schema: k.never(), inputs: [undefined, null, 0, '', [], {}] },
	{ name: 'wrapped never', schema: k.never().nullable().optional(), inputs: [undefined, null, 0] },
	{
		name: 'fixed tuple',
		schema: k.tuple([k.string(), k.number()]),
		inputs: [['a', 1], [1, 'a'], ['a'], ['a', 1, 2], [undefined, 1], Array(2)],
	},
	{
		name: 'rest tuple',
		schema: k.tuple([k.string()], k.number()),
		inputs: [['a'], ['a', 1, 2], ['a', 'b'], [], ['a', undefined]],
	},
	{ name: 'empty tuple', schema: k.tuple([]), inputs: [[], [1], null] },
	{
		name: 'any tuple slots',
		schema: k.tuple([k.any()], k.any()),
		inputs: [[1], [undefined], Array(1), [1, undefined], Object.assign(Array(3), { 0: 1, 2: 2 })],
	},
	{
		name: 'nested tuple',
		schema: k.tuple([k.tuple([k.string()])]),
		inputs: [[['a']], [['a', 'b']], [[]]],
	},
	{
		name: 'default tuple slots',
		schema: k.tuple([k.string().default('x')]),
		inputs: [[], [undefined], Array(1), ['x']],
	},
	{
		name: 'undefined tuple output',
		schema: k.tuple([k.any().transform(() => undefined)]),
		inputs: [[1]],
	},
]

describe.each(Object.entries(converters))('%s converter forms', (_name, convert) => {
	it.each(forms)('matches k acceptance for $name', ({ schema, inputs }) => {
		const converted = convert(schema)
		for (const input of inputs)
			expect(converted.safeParse(input).success, String(input)).toBe(
				schema.safeParse(input).success,
			)
	})
	it('keeps native tuple JSON Schema and refuses nested catch', () => {
		expect(toJSONSchema(convert(k.tuple([k.string()])))).toMatchObject({
			type: 'array',
			prefixItems: [{ type: 'string' }],
		})
		expect(() => convert(k.tuple([k.string().catch('x')]))).toThrow(/catch/)
	})
	it('keeps tuple input checks through wrappers, descriptions and refinements', () => {
		const tuple = k.tuple([k.string().default('x')])
		for (const schema of [
			tuple.describe('tuple'),
			tuple.refine(() => true),
			tuple.optional(),
			tuple.nullable(),
		]) {
			const converted = convert(schema)
			for (const input of [[], [undefined], Array(1)])
				expect(converted.safeParse(input).success).toBe(false)
			expect(converted.safeParse(['x']).success).toBe(true)
		}
	})
	it('keeps bytes and bigint runtime contracts', () => {
		const binary = convert(k.bytes())
		expect(binary.safeParse(new ArrayBuffer(2)).success).toBe(true)
		expect(binary.safeParse('AA==').success).toBe(false)
		expect(() => toJSONSchema(binary)).toThrow()
		expect(convert(k.int64()).safeParse(1n).success).toBe(true)
		expect(convert(k.int64()).safeParse(1).success).toBe(false)
	})
})
