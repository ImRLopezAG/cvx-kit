import { NoOp } from 'convex-helpers/server/customFunctions'
import { defineSchema, makeFunctionReference, queryGeneric } from 'convex/server'
import { v } from 'convex/values'
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vite-plus/test'
import { k } from '../src/k'
import { toJsonSchema } from '../src/json-schema'
import { toZod } from '../src/zod'
import { kCustomQuery } from '../src/registration'

describe('void return declarations', () => {
	it('accepts null and undefined over a native null validator', () => {
		const schema = k.void()
		expect(schema.validator).toEqual(v.null())
		expect(schema.parse(undefined)).toBeUndefined()
		expect(schema.parse(null)).toBeNull()
		expect(schema.safeParse(0).success).toBe(false)
		expect(toJsonSchema(schema)).toMatchObject({ type: 'null' })
		for (const value of [undefined, null]) expect(toZod(schema).safeParse(value).success).toBe(true)
		expect(toZod(schema).safeParse(0).success).toBe(false)
		expect(k.custom().safeParse(undefined).success).toBe(false)
		expect(Object.keys(k)).toContain('void')
	})

	it('serializes a handler with no return statement to null', async () => {
		const query = kCustomQuery(queryGeneric, NoOp)
		const fn = query({ returns: k.void(), handler: () => {} })
		const t = convexTest(defineSchema({}), {
			'./_generated/server.ts': async () => ({}),
			'./functions.ts': async () => ({ fn }),
		})
		expect(await t.query(makeFunctionReference<'query'>('functions:fn'), {})).toBeNull()
	})
})
