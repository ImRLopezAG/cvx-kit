import { describe, expect, it } from 'vitest'
import { zodToConvex } from 'convex-helpers/server/zod4'
import type { GenericValidator, JSONValue } from 'convex/values'
import * as z from 'zod'
import * as mini from 'zod/mini'
import { k } from '../src/k'
import { emailPattern } from '../src/k/formats'
import { kZodIds, toZod } from '../src/zod'
import { toZod as toClassicZod } from '../src/zod-classic'

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

	describe.each(['mini', 'classic option', 'classic entry'] as const)('%s output', (output) => {
		const convert =
			output === 'classic entry'
				? toClassicZod
				: output === 'classic option'
					? classicOption
					: toZod

		// Structural expectations captured from beta.6, extended with email and URL formats.
		describe.each([
			{
				name: 'optional string',
				schema: k.object({ f: k.string().optional() }),
				expected: {
					input: { type: 'object', properties: { f: { type: 'string' } } },
					output: {
						type: 'object',
						properties: { f: { type: 'string' } },
						additionalProperties: false,
					},
				},
			},
			{
				name: 'optional url',
				schema: k.object({ f: k.string().url().optional() }),
				expected: {
					input: { type: 'object', properties: { f: { type: 'string', format: 'uri' } } },
					output: {
						type: 'object',
						properties: { f: { type: 'string', format: 'uri' } },
						additionalProperties: false,
					},
				},
			},
			{
				name: 'optional object',
				schema: k.object({ f: k.object({ x: k.string() }).optional() }),
				expected: {
					input: {
						type: 'object',
						properties: {
							f: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
						},
					},
					output: {
						type: 'object',
						properties: {
							f: {
								type: 'object',
								properties: { x: { type: 'string' } },
								required: ['x'],
								additionalProperties: false,
							},
						},
						additionalProperties: false,
					},
				},
			},
			{
				name: 'optional array',
				schema: k.object({ f: k.array(k.string()).optional() }),
				expected: {
					input: {
						type: 'object',
						properties: { f: { type: 'array', items: { type: 'string' } } },
					},
					output: {
						type: 'object',
						properties: { f: { type: 'array', items: { type: 'string' } } },
						additionalProperties: false,
					},
				},
			},
			{
				name: 'nullable',
				schema: k.object({ f: k.string().nullable() }),
				expected: {
					input: {
						type: 'object',
						properties: { f: { type: ['string', 'null'] } },
						required: ['f'],
					},
					output: {
						type: 'object',
						properties: { f: { type: ['string', 'null'] } },
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'default',
				schema: k.object({ f: k.string().default('a') }),
				expected: {
					input: { type: 'object', properties: { f: { default: 'a', type: 'string' } } },
					output: {
						type: 'object',
						properties: { f: { type: 'string' } },
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'refine',
				schema: k.object({ f: k.number().refine((n) => n > 0) }),
				expected: {
					input: { type: 'object', properties: { f: { type: 'number' } }, required: ['f'] },
					output: {
						type: 'object',
						properties: { f: { type: 'number' } },
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'check',
				schema: k.object({ f: k.string().check(() => {}) }),
				expected: {
					input: { type: 'object', properties: { f: { type: 'string' } }, required: ['f'] },
					output: {
						type: 'object',
						properties: { f: { type: 'string' } },
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'trim',
				schema: k.object({ f: k.string().trim() }),
				expected: {
					input: { type: 'object', properties: { f: { type: 'string' } }, required: ['f'] },
					output: {
						type: 'object',
						properties: { f: { type: 'string' } },
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'lower',
				schema: k.object({ f: k.string().toLowerCase() }),
				expected: {
					input: { type: 'object', properties: { f: { type: 'string' } }, required: ['f'] },
					output: {
						type: 'object',
						properties: { f: { type: 'string' } },
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'upper',
				schema: k.object({ f: k.string().toUpperCase() }),
				expected: {
					input: { type: 'object', properties: { f: { type: 'string' } }, required: ['f'] },
					output: {
						type: 'object',
						properties: { f: { type: 'string' } },
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'overwrite',
				schema: k.object({ f: k.string().overwrite((s) => s.trim()) }),
				expected: {
					input: { type: 'object', properties: { f: { type: 'string' } }, required: ['f'] },
					output: {
						type: 'object',
						properties: { f: { type: 'string' } },
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'bounds',
				schema: k.object({
					f: k
						.string()
						.min(2)
						.max(8)
						.regex(/^[a-z]+$/),
				}),
				expected: {
					input: {
						type: 'object',
						properties: { f: { type: 'string', minLength: 2, maxLength: 8, pattern: '^[a-z]+$' } },
						required: ['f'],
					},
					output: {
						type: 'object',
						properties: { f: { type: 'string', minLength: 2, maxLength: 8, pattern: '^[a-z]+$' } },
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'email',
				schema: k.object({ f: k.string().email() }),
				expected: {
					input: {
						type: 'object',
						properties: {
							f: {
								type: 'string',
								format: 'email',
								pattern:
									"^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\\.)+[A-Za-z]{2,}$",
							},
						},
						required: ['f'],
					},
					output: {
						type: 'object',
						properties: {
							f: {
								type: 'string',
								format: 'email',
								pattern:
									"^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\\.)+[A-Za-z]{2,}$",
							},
						},
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'email factory',
				schema: k.email(),
				expected: {
					input: { type: 'string', format: 'email', pattern: emailPattern.source },
					output: { type: 'string', format: 'email', pattern: emailPattern.source },
				},
			},
			{
				name: 'email with max',
				schema: k.email().max(320),
				expected: {
					input: { type: 'string', format: 'email', pattern: emailPattern.source, maxLength: 320 },
					output: { type: 'string', format: 'email', pattern: emailPattern.source, maxLength: 320 },
				},
			},
			{
				name: 'url',
				schema: k.url(),
				expected: {
					input: { type: 'string', format: 'uri' },
					output: { type: 'string', format: 'uri' },
				},
			},
			{
				name: 'url with protocol',
				schema: k.url({ protocol: /^https$/ }),
				expected: {
					input: { type: 'string', format: 'uri' },
					output: { type: 'string', format: 'uri' },
				},
			},
			{
				name: 'enum',
				schema: k.object({ f: k.enum(['a', 'b']) }),
				expected: {
					input: {
						type: 'object',
						properties: { f: { type: 'string', enum: ['a', 'b'] } },
						required: ['f'],
					},
					output: {
						type: 'object',
						properties: { f: { type: 'string', enum: ['a', 'b'] } },
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'literal union',
				schema: k.object({ f: k.union([k.literal('a'), k.literal('b')]) }),
				expected: {
					input: {
						type: 'object',
						properties: {
							f: {
								anyOf: [
									{ type: 'string', const: 'a' },
									{ type: 'string', const: 'b' },
								],
							},
						},
						required: ['f'],
					},
					output: {
						type: 'object',
						properties: {
							f: {
								anyOf: [
									{ type: 'string', const: 'a' },
									{ type: 'string', const: 'b' },
								],
							},
						},
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'nested',
				schema: k.object({ f: k.object({ x: k.number() }) }),
				expected: {
					input: {
						type: 'object',
						properties: {
							f: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
						},
						required: ['f'],
					},
					output: {
						type: 'object',
						properties: {
							f: {
								type: 'object',
								properties: { x: { type: 'number' } },
								required: ['x'],
								additionalProperties: false,
							},
						},
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'integer',
				schema: k.object({ f: k.int() }),
				expected: {
					input: {
						type: 'object',
						properties: {
							f: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
						},
						required: ['f'],
					},
					output: {
						type: 'object',
						properties: {
							f: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
						},
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'strict',
				schema: k.object({ f: k.string() }).strict(),
				expected: {
					input: {
						type: 'object',
						properties: { f: { type: 'string' } },
						required: ['f'],
						additionalProperties: false,
					},
					output: {
						type: 'object',
						properties: { f: { type: 'string' } },
						required: ['f'],
						additionalProperties: false,
					},
				},
			},
			{
				name: 'loose',
				schema: k.object({ f: k.string() }).loose(),
				expected: {
					input: {
						type: 'object',
						properties: { f: { type: 'string' } },
						required: ['f'],
						additionalProperties: {},
					},
					output: {
						type: 'object',
						properties: { f: { type: 'string' } },
						required: ['f'],
						additionalProperties: {},
					},
				},
			},
			{
				name: 'optional refine',
				schema: k.object({
					f: k
						.string()
						.refine((s) => s.length > 0)
						.optional(),
				}),
				expected: {
					input: { type: 'object', properties: { f: { type: 'string' } } },
					output: {
						type: 'object',
						properties: { f: { type: 'string' } },
						additionalProperties: false,
					},
				},
			},
			{
				name: 'transform',
				schema: k.object({ f: k.string().transform((s) => s.length) }),
				expected: {
					input: { type: 'object', properties: { f: { type: 'string' } }, required: ['f'] },
				},
			},
			{
				name: 'pipe',
				schema: k.object({
					f: k
						.string()
						.transform((s) => s.length)
						.pipe(k.number()),
				}),
				expected: {
					input: { type: 'object', properties: { f: { type: 'string' } }, required: ['f'] },
				},
			},
		])('JSON Schema parity: $name', ({ schema, expected }) => {
			for (const io of ['input', 'output'] as const) {
				if (!(io in expected)) continue
				it(`preserves ${io} JSON Schema`, () => {
					const converted = convert(schema)
					const actual = z.toJSONSchema(converted, { io })
					expect(actual).toEqual({
						$schema: 'https://json-schema.org/draft/2020-12/schema',
						...expected[io],
					})
				})
			}
		})

		it('keeps email and URL parsing unchanged when carrying format metadata', () => {
			for (const schema of [k.email(), k.email().max(320), k.string().email()]) {
				const converted = convert(schema)
				for (const value of [
					'a@b.co',
					"o'neil@example.org",
					`${'a'.repeat(320)}@example.org`,
					'.a@b.co',
					'a..b@c.co',
					'a@b',
					'',
					null,
				])
					expect(converted.safeParse(value).success).toBe(schema.safeParse(value).success)
			}
			for (const schema of [
				k.url(),
				k.url({ protocol: /^https$/ }),
				k.url({ hostname: /^example\.com$/ }),
			]) {
				const converted = convert(schema)
				for (const value of [
					'https://example.com',
					'  https://example.com  ',
					'http:example.com',
					'http://localhost:3000',
					'mailto:a@b.co',
					'custom:opaque',
					'https://other.com',
					'http://',
					'/relative',
					'',
					null,
				])
					expect(converted.safeParse(value).success).toBe(schema.safeParse(value).success)
			}
		})

		it('carries refine messages and relative paths', () => {
			const schema = k.object({ name: k.string() }).refine((value) => value.name === 'yes', {
				message: 'use yes',
				path: ['name'],
			})
			const result = convert(schema).safeParse({ name: 'no' })
			expect(result.success).toBe(false)
			if (!result.success)
				expect(result.error.issues).toMatchObject([
					{ code: 'custom', message: 'use yes', path: ['name'] },
				])
			expect(convert(schema).parse({ name: 'yes' })).toEqual(schema.parse({ name: 'yes' }))
		})

		it('carries every issue added by check', () => {
			const schema = k.string().check((value, context) => {
				if (value !== 'ok') {
					context.addIssue({ message: 'first', path: ['a'] })
					context.addIssue({ code: 'invalid_value', message: 'second', path: ['b'] })
				}
			})
			const result = convert(schema).safeParse('bad')
			expect(result.success).toBe(false)
			if (!result.success)
				expect(result.error.issues).toMatchObject([
					{ message: 'first', path: ['a'] },
					{ code: 'invalid_value', message: 'second', path: ['b'] },
				])
			expect(convert(schema).parse('ok')).toBe('ok')
		})

		it('runs overwrite before checks and carries transform and pipe', () => {
			const trimmed = k
				.string()
				.min(2)
				.overwrite((value) => value.trim())
			expect(convert(trimmed).parse(' ab ')).toBe(trimmed.parse(' ab '))
			expect(convert(trimmed).safeParse(' a ').success).toBe(false)
			const schema = trimmed
				.transform((value) => value.length)
				.pipe(k.number().min(3))
				.refine((value) => value < 5, 'too long')
			expect(convert(schema).parse(' abc ')).toBe(schema.parse(' abc '))
			for (const value of ['ab', 'abcde', 123])
				expect(convert(schema).safeParse(value).success).toBe(schema.safeParse(value).success)
		})

		it('does not encode undefined defaults', () => {
			const transformed = k
				.any()
				.transform((value) => (value === undefined ? 'absent' : value))
				.default(undefined)
			for (const schema of [k.any().default(undefined), transformed]) {
				const converted = convert(schema)
				for (const io of ['input', 'output'] as const)
					expect(() => z.toJSONSchema(converted, { io, unrepresentable: 'any' })).not.toThrow()
			}
			for (const input of [undefined, 'present'])
				expect(convert(transformed).safeParse(input)).toEqual(transformed.safeParse(input))
		})

		it('preserves defaults around transforms', () => {
			const before = k
				.string()
				.default('abc')
				.transform((value) => value.length)
			const after = k
				.string()
				.transform((value) => value.length)
				.default(7)
			expect(convert(before).parse(undefined)).toBe(before.parse(undefined))
			expect(convert(after).parse(undefined)).toBe(after.parse(undefined))
		})

		it('skips overwrite when a wrapped inner run failed', () => {
			const schema = k
				.string()
				.refine(() => false, 'inner failure')
				.optional()
				.overwrite(() => {
					throw new Error('must not execute')
				})
			const expected = schema.safeParse('x')
			const actual = convert(schema).safeParse('x')
			expect(actual.success).toBe(expected.success)
			if (!actual.success && !expected.success)
				expect(actual.error.issues).toMatchObject(expected.issues)
		})

		it('skips outer checks after a failed base but accumulates checks within a run', () => {
			const inner = k.string().refine(() => false, 'inner failure')
			for (const [schema, value] of [
				[inner.optional(), 'x'],
				[inner.nullable(), 'x'],
				[inner.default('x'), undefined],
				[k.object({ a: inner }), { a: 'x' }],
			] as const) {
				const checked = schema.check((_, context) => {
					context.addIssue({ message: 'outer failure' })
				})
				const expected = checked.safeParse(value)
				const actual = convert(checked).safeParse(value)
				expect(actual.success).toBe(expected.success)
				if (!actual.success && !expected.success)
					expect(actual.error.issues.map(({ message }) => message)).toEqual(
						expected.issues.map(({ message }) => message),
					)
			}
			const sameRun = inner.describe('transparent').check((_, context) => {
				context.addIssue({ message: 'same run failure' })
			})
			const expected = sameRun.safeParse('x')
			const actual = convert(sameRun).safeParse('x')
			if (!actual.success && !expected.success)
				expect(actual.error.issues).toMatchObject(expected.issues)
			expect(actual.success).toBe(expected.success)
		})

		it('uses parsed defaults above nested transforms', () => {
			const schema = k
				.object({ a: k.string().transform((value) => value.length) })
				.default({ a: 3 })
			expect(convert(schema).safeParse(undefined)).toEqual(schema.safeParse(undefined))
		})

		it('optional skips defaults hidden behind a transform or pipe', () => {
			for (const schema of [
				k
					.string()
					.default('a')
					.transform((value) => value.length)
					.optional(),
				k.string().default('a').pipe(k.string()).optional(),
			]) {
				expect(convert(schema).safeParse(undefined)).toEqual(schema.safeParse(undefined))
				expect(convert(schema).safeParse('abc')).toEqual(schema.safeParse('abc'))
				expect(() => z.toJSONSchema(convert(schema), { io: 'input' })).not.toThrow()
				const object = k.object({ value: schema })
				expect(convert(object).safeParse({})).toEqual(object.safeParse({}))
			}
			const visible = k
				.string()
				.transform((value) => value.length)
				.default(3)
				.optional()
			expect(convert(visible).safeParse(undefined)).toEqual(visible.safeParse(undefined))
		})

		it('preserves callback failure sentinels and synchronous-only transforms', () => {
			for (const schema of [
				k.string().transform(() => k.NEVER),
				k.string().overwrite(() => k.NEVER),
				k.string().transform(async (value) => value.length),
				k.string().check(async () => {}),
			]) {
				const expected = schema.safeParse('value')
				const actual = convert(schema).safeParse('value')
				expect(actual.success).toBe(expected.success)
				if (!actual.success && !expected.success)
					expect(actual.error.issues).toMatchObject(expected.issues)
			}
		})

		it('carries callback issues from transforms', () => {
			const schema = k.string().transform((value, context) => {
				if (value === 'bad') {
					context.addIssue({ message: 'bad value' })
					return k.NEVER
				}
				return value.length
			})
			const result = convert(schema).safeParse('bad')
			expect(result.success).toBe(false)
			if (!result.success)
				expect(result.error.issues).toMatchObject([
					{ code: 'custom', message: 'bad value', path: [] },
				])
		})

		it('carries operations in fields, elements and union branches', () => {
			const value = k
				.string()
				.overwrite((input) => input.trim())
				.refine((input) => input !== '', 'required')
				.check((input, context) => {
					if (input === 'bad') context.addIssue({ message: 'bad' })
				})
				.transform((input) => input.length)
				.pipe(k.number().min(2))
			const schema = k.object({
				field: value,
				elements: k.array(value),
				branch: k.union([value, k.boolean()]),
			})
			const converted = convert(schema)
			const good = { field: ' hi ', elements: [' hey '], branch: ' yes ' }
			expect(converted.parse(good)).toEqual(schema.parse(good))
			for (const input of ['', 'bad', 'x']) {
				for (const invalid of [
					{ ...good, field: input },
					{ ...good, elements: [input] },
					{ ...good, branch: input },
				])
					expect(converted.safeParse(invalid).success).toBe(schema.safeParse(invalid).success)
			}
		})

		it('keeps catch explicitly unsupported', () => {
			expect(() => convert(k.string().catch('fallback'))).toThrow('toZod: .catch() is not carried')
		})
	})

	it.each([classicOption, toClassicZod])('builds classic schemas with chain methods', (convert) => {
		const converted = convert(task)
		expect(converted).toBeInstanceOf(z.ZodType)
		expect(converted.optional().parse(undefined)).toBeUndefined()
		expect(converted.parse(valid)).toEqual(task.parse(valid))
		expect(converted.safeParse({ ...valid, count: -1 }).success).toBe(false)
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

	it('produces zod/mini schemas whose ids are strings tagged with their table', () => {
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
		const owner = toZod(k.id('users'))
		expect(kZodIds.get(owner)).toEqual({ tableName: 'users' })
		expect(owner.safeParse('u1').success).toBe(true)
		expect(owner.safeParse(1).success).toBe(false)
		// convex-helpers sees the id as a plain string; every other field converts back unchanged.
		const asString = k.object({ ...schema.shape, owner: k.string() })
		expect(json(zodToConvex(zod))).toEqual(json(asString.validator))
		// A result is extended with zod/mini functions.
		expect(mini.optional(zod).safeParse(undefined).success).toBe(true)
	})

	it('keeps the installed .toZod() method on Mini output after importing the classic entry', () => {
		const zod = task.shape.title.toZod()
		expect(zod).toBeInstanceOf(z.core.$ZodType)
		expect(zod).not.toBeInstanceOf(z.ZodType)
		expect(zod.parse(' a ')).toBe('a')
		expect(k.string().optional().toZod().parse(undefined)).toBeUndefined()
	})
})

function classicOption<S extends import('../src/k/types').KType>(schema: S) {
	return toZod(schema, { zod: z })
}
