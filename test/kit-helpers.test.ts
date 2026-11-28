import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { paginationOptsValidator } from 'convex/server'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'
import type { GenericId } from 'convex/values'
import { toJSONSchema } from 'zod/mini'
import { toZod } from '../src/zod'
import { toJsonSchema } from '../src/json-schema'
import { componentResult } from '../src/contracts'
import { convexPaginationOptions as rootPagination } from '../src/index'
import { k } from '../src/k'
import { convexPaginationOptions } from '../src/table'
import { asId } from '../src/test'

describe('kit helpers', () => {
	it('keeps the documented ArrayBuffer and bigint wire limits', () => {
		const buffer = new ArrayBuffer(2)
		expect(k.bytes().parse(buffer)).toBe(buffer)
		expect(toZod(k.bytes()).parse(buffer)).toBe(buffer)
		expect(() => toJSONSchema(toZod(k.bytes()))).toThrow(/Custom types/)
		expect(toJsonSchema(k.bytes())).toMatchObject({ type: 'string', contentEncoding: 'base64' })
		expect(toJsonSchema(k.int64())).toMatchObject({ type: 'integer' })
		expect(k.int64().parse(1n)).toBe(1n)
		expect(k.int64().safeParse(1).success).toBe(false)
	})

	it('brands a fixture id without changing or validating its value', () => {
		const id = asId('deliveries', 'fixture-delivery-1')
		expect(id).toBe('fixture-delivery-1')
		expectTypeOf(id).toEqualTypeOf<GenericId<'deliveries'>>()
	})
	it('decodes component results strictly without eagerly compiling', () => {
		const schema = k.object({ delivery: k.object({ id: k.id('deliveries') }) })
		const decode = componentResult(schema)
		expect(schema.plan).toBeUndefined()
		expect(schema.native).toBeUndefined()
		const result = decode({ delivery: { id: 'component-local' } })
		expectTypeOf(result.delivery.id).toEqualTypeOf<GenericId<'deliveries'>>()
		expect(result).toEqual({ delivery: { id: 'component-local' } })
		for (const value of [{ delivery: { id: 1 } }, { delivery: { id: 'x', extra: true } }, {}])
			expect(() => decode(value)).toThrow()
	})
	it('exports the cached native six-field pagination schema from table and root', () => {
		const schema = convexPaginationOptions()
		expect(rootPagination()).toBe(schema)
		expect(convexPaginationOptions()).toBe(schema)
		expect(nativeJson(schema.validator)).toEqual(nativeJson(paginationOptsValidator))
		expect(Object.keys(schema.shape).sort()).toEqual([
			'cursor',
			'endCursor',
			'id',
			'maximumBytesRead',
			'maximumRowsRead',
			'numItems',
		])
		expect(
			k.object({ paginationOpts: schema }).parse({
				paginationOpts: {
					numItems: 10,
					cursor: null,
					endCursor: 'x',
					id: 1,
					maximumBytesRead: 2,
					maximumRowsRead: 3,
				},
			}),
		).toEqual({
			paginationOpts: {
				numItems: 10,
				cursor: null,
				endCursor: 'x',
				id: 1,
				maximumBytesRead: 2,
				maximumRowsRead: 3,
			},
		})
	})
})

function nativeJson(validator: GenericValidator): ValidatorJSON {
	// SAFETY: Convex exposes json at runtime but marks it internal in declarations.
	return (validator as GenericValidator & { readonly json: ValidatorJSON }).json
}
