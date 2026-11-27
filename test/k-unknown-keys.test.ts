import { describe, expect, it } from 'vite-plus/test'
import { kContract } from '../src/contracts'
import { toJsonSchema } from '../src/json-schema'
import { k } from '../src/k'
import { runDeclared } from '../src/k/parse'
import { kTable, kVariantTable } from '../src/table'
import { toZod } from '../src/zod'

const codes = (result: { success: boolean; issues?: readonly { code: string }[] }) =>
	result.success ? [] : (result.issues ?? []).map((issue) => issue.code)

describe('unknown keys: parse strips, boundaries reject', () => {
	const address = k.object({ city: k.string() })
	const user = k.object({ name: k.string(), address, tags: k.array(address).optional() })
	const input = {
		name: 'n',
		address: { city: 'c', zip: 1 },
		tags: [{ city: 'd', zip: 2 }],
		role: 'admin',
	}
	const clean = { name: 'n', address: { city: 'c' }, tags: [{ city: 'd' }] }

	it('parse, safeParse and Standard Schema remove unknown keys at every depth', () => {
		expect(user.parse(input)).toEqual(clean)
		expect(user.safeParse(input)).toEqual({ success: true, data: clean })
		expect(user['~standard'].validate(input)).toEqual({ value: clean })
		const exact = { name: 'n', address: { city: 'c' } }
		expect(user.parse(exact)).toBe(exact)
	})

	it('the boundary parse reports every unknown key', () => {
		const result = user['~safeParseStrict'](input)
		expect(result.success ? [] : result.issues.map((issue) => issue.path)).toEqual([
			['address', 'zip'],
			['tags', 0, 'zip'],
			['role'],
		])
		expect(() => user['~parseStrict'](input)).toThrow()
		expect(kContract(user).decode(input)).toMatchObject({
			issues: [{ code: 'unrecognized_key' }, {}, {}],
		})
		expect(kContract(user).decode(clean)).toEqual({ value: clean })
	})

	it('.strict() and k.strictObject reject for that object only, as Zod does', () => {
		const strict = k.strictObject({ name: k.string(), address })
		expect(codes(strict.safeParse({ name: 'n', address: { city: 'c' }, role: 1 }))).toEqual([
			'unrecognized_key',
		])
		expect(strict.parse({ name: 'n', address: { city: 'c', zip: 1 } })).toEqual({
			name: 'n',
			address: { city: 'c' },
		})
		expect(codes(user.strict().safeParse(input))).toEqual(['unrecognized_key'])
	})

	it('the last policy declared on a chain wins', () => {
		const extra = { city: 'c', zip: 1 }
		expect(address.strict().strip().parse(extra)).toEqual({ city: 'c' })
		expect(address.strip().strict().safeParse(extra).success).toBe(false)
		expect(address.strict().loose().parse(extra)).toEqual(extra)
		expect(address.loose().strip().parse(extra)).toEqual({ city: 'c' })
		expect(address.loose().strict().optional().safeParse(extra).success).toBe(false)
	})

	it('.strip() strips at the boundary parse too; a plain object does not', () => {
		expect(address.strip()['~parseStrict']({ city: 'c', zip: 1 })).toEqual({ city: 'c' })
		expect(address['~safeParseStrict']({ city: 'c', zip: 1 }).success).toBe(false)
	})

	it('derived objects keep strict, and literal-key records are strict', () => {
		const strict = k.strictObject({ a: k.string(), b: k.string() })
		for (const derived of [strict.pick('a'), strict.partial(), strict.extend({ c: k.string() })])
			expect(codes(derived.safeParse({ a: 'a', zz: 1 }))).toContain('unrecognized_key')
		expect(address.pick('city').parse({ city: 'c', zip: 1 })).toEqual({ city: 'c' })
		expect(k.record(k.enum(['a', 'b']), k.number()).safeParse({ a: 1, b: 2, c: 3 }).success).toBe(
			false,
		)
		expect(k.partialRecord(k.enum(['a', 'b']), k.number()).safeParse({ c: 3 }).success).toBe(false)
	})

	it('a union prefers the member that accepts every key over an earlier one that would drop some', () => {
		const union = k.union([k.object({ a: k.string() }), k.object({ a: k.string(), b: k.number() })])
		expect(union.parse({ a: 'x', b: 1 })).toEqual({ a: 'x', b: 1 })
		expect(union.parse({ a: 'x', c: 1 })).toEqual({ a: 'x' })
		expect(union.parse({ a: 'x', b: 1, c: 1 })).toEqual({ a: 'x' })
		expect(union['~safeParseStrict']({ a: 'x', c: 1 }).success).toBe(false)
		const nested = k.object({ items: k.array(union) })
		expect(
			nested.parse({
				items: [
					{ a: 'x', b: 1 },
					{ a: 'y', z: 0 },
				],
				more: 1,
			}),
		).toEqual({
			items: [{ a: 'x', b: 1 }, { a: 'y' }],
		})
		// The policy is restored after a union, on success and on failure.
		const after = k.object({ u: union.optional(), o: address })
		expect(after.parse({ u: { a: 'x', z: 1 }, o: { city: 'c', zip: 1 } })).toEqual({
			u: { a: 'x' },
			o: { city: 'c' },
		})
		expect(
			k.object({ u: k.union([k.string(), k.number()]).catch('f'), o: address }).parse({
				u: true,
				o: { city: 'c', zip: 1 },
			}),
		).toEqual({ u: 'f', o: { city: 'c' } })
	})

	it('a union probe does not turn a strippable value into a catch fallback', () => {
		const caught = k.object({ a: k.string() }).catch({ a: 'fallback' })
		expect(k.union([caught, k.number()]).parse({ a: 'valid', extra: 1 })).toEqual({ a: 'valid' })
		expect(k.union([caught, k.number()]).parse({ a: 1 })).toEqual({ a: 'fallback' })
		const inner = k.union([caught, k.number()])
		expect(k.union([inner, k.string()]).parse({ a: 'valid', extra: 1 })).toEqual({ a: 'valid' })
		const exact = k.object({ a: k.string(), extra: k.number() })
		expect(k.union([caught, exact]).parse({ a: 'valid', extra: 1 })).toEqual({
			a: 'valid',
			extra: 1,
		})
	})

	it('a table projection follows the last policy of a field object', () => {
		const meta = k.object({ a: k.string() })
		const row = { meta: { a: 'a', extra: 1 } }
		// SAFETY: the cast models a stored row that holds a key outside the field's declared shape.
		const project = (field: typeof meta) =>
			kTable('t', { meta: field }, { publicFields: ['meta'] }).toPublicDto(row as never)
		expect(project(meta.strict().strip())).toEqual({ meta: { a: 'a' } })
		expect(() => project(meta.strip().strict())).toThrow()
		expect(() => project(meta)).toThrow()
	})

	it('a variant table accepts strict branches', () => {
		const events = kVariantTable(
			'events',
			k.discriminatedUnion('type', [
				k.strictObject({ type: k.literal('a'), x: k.string() }),
				k
					.object({ type: k.literal('b') })
					.strict()
					.describe('b'),
			]),
			{ discriminator: 'type', variants: { a: {}, b: {} } },
		)
		expect(events.insertSchema.safeParse({ type: 'a', x: 'x' }).success).toBe(true)
		expect(events.insertSchema.safeParse({ type: 'a', x: 'x', extra: 1 }).success).toBe(false)
		expect(() =>
			kVariantTable(
				'events',
				k.discriminatedUnion('type', [k.object({ type: k.literal('a') }).strip()]),
				{ discriminator: 'type', variants: { a: {} } },
			),
		).toThrow('object-level refinements')
	})

	it('a discriminated union strips in parse and rejects at the boundary', () => {
		const event = k.discriminatedUnion('kind', [
			k.object({ kind: k.literal('a'), n: k.number() }),
			k.strictObject({ kind: k.literal('b') }),
		])
		expect(event.parse({ kind: 'a', n: 1, extra: 1 })).toEqual({ kind: 'a', n: 1 })
		expect(event.safeParse({ kind: 'b', extra: 1 }).success).toBe(false)
		expect(event['~safeParseStrict']({ kind: 'a', n: 1, extra: 1 }).success).toBe(false)
	})

	it('a plain object parses a class instance from its own properties; a strict one does not', () => {
		class Tagged extends Error {
			readonly _tag = 'T'
		}
		expect(k.object({ _tag: k.string() }).parse(new Tagged('x'))).toEqual({ _tag: 'T' })
		expect(k.strictObject({ _tag: k.string() }).safeParse(new Tagged('x')).success).toBe(false)
		expect(k.object({ _tag: k.string() })['~safeParseStrict'](new Tagged('x')).success).toBe(false)
	})

	it('the native validator and the function boundary are unchanged', () => {
		expect(user.strict().validator).toBe(user.validator)
		expect(user.validator.fields.address.kind).toBe('object')
		// The plan-only boundary run never strips: Convex has already rejected unknown keys.
		const trimmed = k.object({ name: k.string().trim(), address })
		expect(runDeclared(trimmed, { name: ' n ', address: { city: 'c' } })).toEqual({
			name: 'n',
			address: { city: 'c' },
		})
	})

	it('JSON Schema stays closed for a plain and a strict object; Zod interop follows parse', () => {
		expect(toJsonSchema(address)).toMatchObject({ additionalProperties: false })
		expect(toJsonSchema(address.strip().strict())).toMatchObject({ additionalProperties: false })
		expect(toJsonSchema(address.strict().strip())).not.toHaveProperty('additionalProperties')
		expect(toZod(address).parse({ city: 'c', zip: 1 })).toEqual({ city: 'c' })
		expect(toZod(address.strict()).safeParse({ city: 'c', zip: 1 }).success).toBe(false)
		expect(toZod(address.loose()).parse({ city: 'c', zip: 1 })).toEqual({ city: 'c', zip: 1 })
	})

	it('table schemas reject unknown keys under parse, as v1 did', () => {
		const notes = kTable('notes', { text: k.string(), meta: k.object({ a: k.string() }) })
		const row = { text: 't', meta: { a: 'a' } }
		expect(notes.insertSchema.safeParse({ ...row, extra: 1 }).success).toBe(false)
		expect(notes.updateSchema.safeParse({ extra: 1 }).success).toBe(false)
		expect(notes.dto().safeParse({ ...row, extra: 1 }).success).toBe(false)
		expect(notes.insertSchema.omit('meta').safeParse({ text: 't', extra: 1 }).success).toBe(false)
	})
})

describe('integers are safe by default', () => {
	it('k.int() and .int() reject integers a double cannot hold exactly', () => {
		for (const schema of [k.int(), k.number().int(), k.int().safe(), k.number().safe()]) {
			expect(schema.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
			expect(schema.parse(Number.MIN_SAFE_INTEGER)).toBe(Number.MIN_SAFE_INTEGER)
			expect(codes(schema.safeParse(2 ** 53))).toEqual(['too_big'])
			expect(codes(schema.safeParse(-(2 ** 53)))).toEqual(['too_small'])
			expect(codes(schema.safeParse(1.5))).toEqual(['not_integer'])
			expect(codes(schema.safeParse(Number.POSITIVE_INFINITY))).toEqual(['not_integer'])
			expect(codes(schema.safeParse(Number.NaN))).toEqual(['not_integer'])
		}
		expect(codes(k.int().safeParse('1'))).toEqual(['invalid_type'])
	})

	it('the function boundary applies the range after Convex accepted the number', () => {
		const args = k.object({ count: k.int(), size: k.number().int().optional() })
		expect(() => runDeclared(args, { count: 2 ** 53 })).toThrow()
		expect(() => runDeclared(args, { count: 1, size: 2 ** 60 })).toThrow()
		expect(runDeclared(args, { count: 1, size: 2 })).toEqual({ count: 1, size: 2 })
	})

	it('JSON Schema states the range with or without .safe()', () => {
		const range = {
			type: 'integer',
			minimum: Number.MIN_SAFE_INTEGER,
			maximum: Number.MAX_SAFE_INTEGER,
		}
		for (const schema of [k.int(), k.int().safe(), k.number().int(), k.number().safe()])
			expect(toJsonSchema(schema)).toMatchObject(range)
		expect(toJsonSchema(k.int().min(1).max(10))).toMatchObject({ minimum: 1, maximum: 10 })
		expect(toJsonSchema(k.number())).not.toHaveProperty('minimum')
	})

	it('.int() keeps its message for both failures; k.number() is unchanged', () => {
		const whole = k.number().int('whole')
		expect(whole.safeParse(1.5)).toMatchObject({ issues: [{ message: 'whole' }] })
		expect(whole.safeParse(2 ** 53)).toMatchObject({ issues: [{ message: 'whole' }] })
		expect(k.number().parse(2 ** 60)).toBe(2 ** 60)
	})
})
