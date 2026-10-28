import { expect, test } from 'vite-plus/test'
import { z } from 'zod'
import { defineRelations } from '../src/relations'
import { zodTable, zodToConvex } from '../src/zod-table'
import { captureDto, materializeDto } from '../src/querying/schema-snapshot'
import type { JSONValue } from 'convex/values'

function originalCanonical(value: JSONValue): string {
	if (Array.isArray(value)) return `[${value.map(originalCanonical).join(',')}]`
	if (value !== null && Object(value) === value) {
		// SAFETY: JSONValue excludes functions, and the array and null branches above leave only a JSON object.
		const object = value as { [key: string]: JSONValue }
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${originalCanonical(object[key])}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}

test('revision1 preserves original canonical DTO identity bytes for nested and escaped keys', () => {
	const table = zodTable(
		'items',
		() => ({
			'10': z.string(),
			'2': z.number(),
			'a"\\\n': z.object({
				z: z.array(z.union([z.literal('"\\\n'), z.literal(false), z.literal(17)])),
				a: z.object({}).optional(),
				b: z.string().nullable(),
			}),
		}),
		{ publicFields: ['10', '2', 'a"\\\n'] },
	)
	const native = zodToConvex(materializeDto(captureDto(table.dto(true))))
	// SAFETY: native validators expose runtime JSON omitted from declarations.
	const expected = originalCanonical((native as typeof native & { json: JSONValue }).json)
	const registry = defineRelations({ items: table }, () => ({ items: {} }))
	const identity: unknown[] = JSON.parse(registry.identity)
	// SAFETY: defineRelations emits the versioned identity tuple with the table-entry array at index 1.
	const tables = identity[1] as unknown[][]
	expect(tables[0][4]).toBe(expected)
	expect(expected).toContain('"10"')
	expect(expected.indexOf('"10"')).toBeLessThan(expected.indexOf('"2"'))
})
