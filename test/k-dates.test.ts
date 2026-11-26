import { readFileSync } from 'node:fs'
import { v } from 'convex/values'
import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { describe, expect, it } from 'vitest'
import { k } from '../src/k'
import { KTransform } from '../src/k/schema'
import { containsTransform, runDeclared } from '../src/k/parse'

function nativeJson(validator: GenericValidator): string {
	// SAFETY: Convex validators expose the json getter at runtime; declarations mark it internal.
	return JSON.stringify((validator as GenericValidator & { readonly json: ValidatorJSON }).json)
}

function accepts(
	schema: { safeParse(value: string | number): { success: boolean } },
	value: string | number,
) {
	return schema.safeParse(value).success
}

describe('k dates', () => {
	it('builds native string and number validators', () => {
		expect(nativeJson(k.isoDate().validator)).toBe(nativeJson(v.string()))
		expect(nativeJson(k.isoDateTime().validator)).toBe(nativeJson(v.string()))
		expect(nativeJson(k.timestamp().validator)).toBe(nativeJson(v.number()))
	})

	it('accepts real calendar dates only, leap years included', () => {
		expect(accepts(k.isoDate(), '2026-02-29')).toBe(false)
		expect(accepts(k.isoDate(), '2028-02-29')).toBe(true)
		expect(accepts(k.isoDate(), '2000-02-29')).toBe(true)
		expect(accepts(k.isoDate(), '1900-02-29')).toBe(false)
		expect(accepts(k.isoDate(), '2026-04-31')).toBe(false)
		expect(accepts(k.isoDate(), '2026-12-31')).toBe(true)
	})

	it('rejects malformed dates and date-times in isoDate', () => {
		for (const value of [
			'2026-13-01',
			'2026-1-1',
			'2026-11-26T00:00:00Z',
			'2026-00-10',
			' 2026-01-01',
		]) {
			expect(k.isoDate().safeParse(value)).toMatchObject({
				success: false,
				issues: [{ code: 'invalid_format' }],
			})
		}
		expect(k.isoDate().safeParse(20260101)).toMatchObject({ issues: [{ code: 'invalid_type' }] })
	})

	it('accepts Z and numeric offsets in isoDateTime and rejects a missing time', () => {
		expect(accepts(k.isoDateTime(), '2026-11-26T10:20:30Z')).toBe(true)
		expect(accepts(k.isoDateTime(), '2026-11-26T10:20:30.123Z')).toBe(true)
		expect(accepts(k.isoDateTime(), '2026-11-26T10:20:30+05:30')).toBe(true)
		expect(accepts(k.isoDateTime(), '2026-11-26T10:20:30-08:00')).toBe(true)
		expect(accepts(k.isoDateTime(), '2026-11-26')).toBe(false)
		expect(accepts(k.isoDateTime(), '2026-11-26T10:20:30')).toBe(false)
		expect(accepts(k.isoDateTime(), '2026-11-26T24:00:00Z')).toBe(false)
		expect(accepts(k.isoDateTime(), '2026-02-30T10:00:00Z')).toBe(false)
		expect(accepts(k.isoDateTime(), '2026-11-26T10:20:30+0530')).toBe(false)
	})

	it('rejects non-integer, negative and non-finite timestamps', () => {
		expect(k.timestamp().parse(0)).toBe(0)
		expect(k.timestamp().parse(1_764_115_200_000)).toBe(1_764_115_200_000)
		expect(k.timestamp().safeParse(1.5)).toMatchObject({ issues: [{ code: 'not_integer' }] })
		expect(k.timestamp().safeParse(-1)).toMatchObject({ issues: [{ code: 'too_small' }] })
		expect(k.timestamp().safeParse(Number.POSITIVE_INFINITY)).toMatchObject({
			issues: [{ code: 'invalid_type' }],
		})
		expect(k.timestamp().safeParse(Number.NaN).success).toBe(false)
	})

	it('converts ISO strings to timestamps and back', () => {
		const ms = Date.UTC(2026, 10, 26)
		expect(k.isoDateTime().toTimestamp().parse('2026-11-26T00:00:00Z')).toBe(ms)
		expect(k.isoDateTime().toTimestamp().parse('2026-11-26T02:00:00+02:00')).toBe(ms)
		expect(k.isoDate().toTimestamp().parse('2026-11-26')).toBe(ms)
		expect(k.isoDate().toTimestamp().safeParse('0050-01-01').success).toBe(false)
		expect(k.timestamp().toIsoDateTime().parse(ms)).toBe('2026-11-26T00:00:00.000Z')
		expect(k.timestamp().toIsoDate().parse(ms)).toBe('2026-11-26')
		const roundTrip = k.isoDateTime().toTimestamp().pipe(k.timestamp().toIsoDateTime())
		expect(roundTrip.parse('2026-11-26T00:00:00.000Z')).toBe('2026-11-26T00:00:00.000Z')
		expect(k.isoDateTime().toTimestamp().safeParse('2026-11-26').success).toBe(false)
	})

	it('makes conversions transforms, which table fields reject per R9', () => {
		const field = k.isoDate().toTimestamp()
		expect(field).toBeInstanceOf(KTransform)
		expect(containsTransform(k.object({ due: field }))).toBe(true)
		expect(containsTransform(k.object({ due: k.isoDate() }))).toBe(false)
		expect(nativeJson(field.validator)).toBe(nativeJson(v.string()))
	})

	it('keeps chain methods and checks formats at the function boundary', () => {
		const schema = k.object({ due: k.isoDate().optional(), at: k.timestamp().max(10) })
		expect(schema.safeParse({ at: 11 }).success).toBe(false)
		expect(() => runDeclared(schema, { due: '2026-02-30', at: 1 })).toThrow()
		expect(runDeclared(schema, { due: '2026-02-28', at: 1 })).toEqual({ due: '2026-02-28', at: 1 })
	})

	it('imports nothing outside src/k and convex/values', () => {
		for (const file of ['dates.ts', 'formats.ts']) {
			const source = readFileSync(new URL(`../src/k/${file}`, import.meta.url), 'utf8')
			for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) {
				expect(specifier.startsWith('./') || specifier === 'convex/values').toBe(true)
			}
		}
	})
})
