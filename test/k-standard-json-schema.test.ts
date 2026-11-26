import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { toJsonSchema } from '../src/json-schema'
import { k } from '../src/k'

/**
 * A stand-in for a tool library (TanStack AI is not installed here): it accepts any Standard Schema
 * that also implements Standard JSON Schema, and reads the input JSON Schema the way the spec says.
 */
function toolInputSchema<S extends StandardSchemaV1 & StandardJSONSchemaV1>(schema: S) {
	const standard = schema['~standard']
	if (!('jsonSchema' in standard))
		throw new Error(
			'Schema is a Standard Schema validator but does not expose a JSON Schema converter on ~standard.jsonSchema',
		)
	return standard.jsonSchema.input({ target: 'draft-2020-12' })
}

describe('Standard JSON Schema on ~standard', () => {
	const input = k.object({ city: k.string().min(1), days: k.int().default(3) })

	it('exposes input and output converters once cvx-kit/json-schema is imported', () => {
		expect(toolInputSchema(input)).toEqual({
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			...toJsonSchema(input),
		})
		expect(input['~standard'].jsonSchema.output({ target: 'draft-2020-12' })).toEqual({
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			...toJsonSchema(input, { io: 'output' }),
		})
		expect(input['~standard'].jsonSchema.input({ target: 'draft-07' }).$schema).toBe(
			'http://json-schema.org/draft-07/schema#',
		)
	})

	it('throws for a target it does not support, as the spec asks', () => {
		expect(() => input['~standard'].jsonSchema.input({ target: 'openapi-3.0' })).toThrow(
			/'openapi-3.0' is not supported/,
		)
	})

	it('is typed through the spec interfaces', () => {
		expectTypeOf(input).toMatchTypeOf<StandardJSONSchemaV1<unknown, { city: string; days: number }>>()
		expectTypeOf(input['~standard'].jsonSchema).toEqualTypeOf<StandardJSONSchemaV1.Converter>()
	})
})

describe('$defs reuse', () => {
	const filter = k.object({ field: k.string(), op: k.enum(['eq', 'ne']), value: k.any() })
	const contract = k.object({
		where: k.array(filter),
		and: k.array(filter),
		nested: k.object({ or: k.array(filter) }),
		single: k.string(),
	})

	it('keeps the inline output by default', () => {
		const inline = toJsonSchema(contract)
		expect(JSON.stringify(inline)).not.toContain('$ref')
		expect(inline.properties?.where).toEqual({ type: 'array', items: toJsonSchema(filter) })
	})

	it('emits a sub-schema repeated by identity once under $defs with refs: true', () => {
		const out = toJsonSchema(contract, { refs: true })
		expect(out.$defs).toEqual({ s0: toJsonSchema(filter) })
		expect(out.properties?.where).toEqual({ type: 'array', items: { $ref: '#/$defs/s0' } })
		expect(out.properties?.and).toEqual({ type: 'array', items: { $ref: '#/$defs/s0' } })
		expect(out.properties?.nested?.properties?.or).toEqual({
			type: 'array',
			items: { $ref: '#/$defs/s0' },
		})
		// Shared scalar roots (every k.string() is one instance) are never moved into $defs.
		expect(out.properties?.single).toEqual({ type: 'string' })
	})

	it('uses definitions for draft-07 when asked through libraryOptions', () => {
		const out = contract['~standard'].jsonSchema.input({
			target: 'draft-07',
			libraryOptions: { refs: true },
		})
		expect(Object.keys(out)).toContain('definitions')
		expect(JSON.stringify(out)).toContain('#/definitions/s0')
	})
})
