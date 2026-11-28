import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { defineSchema, queryGeneric } from 'convex/server'
import { convexTest } from 'convex-test'
import { NoOp } from 'convex-helpers/server/customFunctions'
import { kCustomQuery } from '../src/registration'
import { describe, expect, it } from 'vite-plus/test'
import { ipv4, ipv6, uuid } from 'zod/mini'
import { k } from '../src/k'
import { runDeclared } from '../src/k/parse'
import { kTable } from '../src/table'

describe('scalar forms', () => {
	it('matches the pinned IP and UUID constructors, including malformed near misses', () => {
		const cases = [
			[
				k.ipv4(),
				ipv4(),
				[
					'0.0.0.0',
					'255.255.255.255',
					'01.2.3.4',
					'256.1.1.1',
					'1.2.3.4:80',
					'1.2.3.4/24',
					' 1.2.3.4',
					'',
					'1.2.3.4 ',
					'[1.2.3.4]',
					'1.2.3.4\n',
				],
			],
			[
				k.ipv6(),
				ipv6(),
				[
					'::',
					'::1',
					'2001:DB8::1',
					'1:2:3:4:5:6:7:8',
					'1::2::3',
					'fe80::1%en0',
					'::ffff:192.0.2.1',
					'1:2:3:4:5:6:7:8:9',
					'[::1]',
					'[::1]:80',
					'::1/64',
					'',
					' ::1',
					'::1 ',
					'::1\n',
					'::@1\\',
					'::ffff:1.2.3.4',
				],
			],
			[
				k.uuid(),
				uuid(),
				[
					'12345678-1234-1234-8234-123456789abc',
					'12345678-1234-8234-B234-123456789ABC',
					'00000000-0000-0000-0000-000000000000',
					'ffffffff-ffff-ffff-ffff-ffffffffffff',
					'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
					'12345678-1234-9234-8234-123456789abc',
					'12345678-1234-4234-7234-123456789abc',
				],
			],
		] as const
		for (const [schema, zod, values] of cases) {
			for (const value of values)
				expect(schema.safeParse(value).success, value).toBe(zod.safeParse(value).success)
			expect(schema.validator.kind).toBe('string')
			expect(schema.safeParse(1).success).toBe(false)
		}
		expect(k.string().trim().ipv4().parse(' 1.2.3.4 ')).toBe('1.2.3.4')
		expect(k.string().toLowerCase().uuid().parse('FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF')).toBe(
			'ffffffff-ffff-ffff-ffff-ffffffffffff',
		)
		expect(k.string().ipv6('bad address').safeParse('bad')).toMatchObject({
			issues: [{ code: 'invalid_format', message: 'bad address' }],
		})
		expect(() => runDeclared(k.ipv4(), 'invalid')).toThrow()
	})
	it('checks exclusive bounds and decimal multiples with finite quotients', () => {
		const schema = k.number().gt(-1).lt(1).multipleOf(0.05)
		for (const value of [0, 0.3, -0.3, 0.95]) expect(schema.parse(value)).toBe(value)
		for (const value of [-1, 1, 0.31, NaN, Infinity, -Infinity])
			expect(schema.safeParse(value).success).toBe(false)
		expect(k.number().multipleOf(Number.MIN_VALUE).safeParse(Number.MAX_VALUE).success).toBe(false)
		for (const divisor of [0, -1, NaN, Infinity, -Infinity])
			expect(() => k.number().multipleOf(divisor)).toThrow()
		expect(() => k.number().gt(NaN)).toThrow()
		expect(() => k.number().lt(NaN)).toThrow()
		expect(k.number().gt(-Infinity).lt(Infinity).parse(1)).toBe(1)
		expect(k.number().multipleOf(2, 'even').safeParse(3)).toMatchObject({
			issues: [{ message: 'even' }],
		})
		expect(schema.validator.kind).toBe('float64')
	})
	it('exports never in argument metadata and rejects insertions in convex-test', async () => {
		const query = kCustomQuery(queryGeneric, NoOp)
		const fn = query({ args: { impossible: k.never() }, handler: () => null })
		// SAFETY: Convex exposes exportArgs at runtime for deployment metadata.
		const exported = retyped<{ exportArgs(): string }>(fn)
		expect(JSON.parse(exported.exportArgs())).toMatchObject({
			value: { impossible: { fieldType: { type: 'union', value: [] } } },
		})
		const table = kTable('neverRows', { impossible: k.never() })
		const t = convexTest(defineSchema({ neverRows: table.table }), {
			'./_generated/server.ts': async () => ({}),
		})
		await expect(
			t.run((ctx) => ctx.db.insert('neverRows', retyped<{ impossible: never }>({ impossible: 1 }))),
		).rejects.toThrow()
	})

	it('never rejects every value and serializes an empty native union', () => {
		for (const value of [undefined, null, false, 1, '', [], {}])
			expect(k.never().safeParse(value)).toMatchObject({ issues: [{ code: 'invalid_type' }] })
		expect(k.never().optional().parse(undefined)).toBeUndefined()
		expect(k.never().nullable().parse(null)).toBeNull()
		expect(nativeJson(k.never().validator)).toEqual({ type: 'union', value: [] })
		expect(k.array(k.never()).parse([])).toEqual([])
		expect(k.array(k.never()).safeParse([1]).success).toBe(false)
		expect(k.union([k.never(), k.string()]).parse('ok')).toBe('ok')
		expect(() => runDeclared(k.never(), 'anything')).toThrow()
		const table = kTable('impossible', { value: k.never() })
		expect(table.insertSchema.safeParse({ value: 1 }).success).toBe(false)
	})
})

function nativeJson(validator: GenericValidator): ValidatorJSON {
	// SAFETY: Convex exposes json at runtime but marks it internal in declarations.
	return (validator as GenericValidator & { readonly json: ValidatorJSON }).json
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test-only access to runtime registration hooks and deliberate malformed inserts.
function retyped<T>(value: unknown): T {
	// SAFETY: tests intentionally inspect untyped hooks and send values that validators must reject.
	return value as T
}
