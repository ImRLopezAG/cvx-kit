import { describe, expect, test } from 'vite-plus/test'
import { z } from 'zod'
import { captureDto, materializeDto } from '../src/querying/schema-snapshot'
import { lazyOptional } from '../src/querying/shared/lazy'

describe('lazy optionals in DTO capture', () => {
	test('a kit-built lazy optional captures and materializes like the eager schema', () => {
		const lazy = z.strictObject({ filters: lazyOptional(() => z.strictObject({ title: z.string() })) })
		// A zod clone keeps the accessor, so the clone must capture as well.
		const cloned = lazy.extend({ limit: z.number() })
		for (const schema of [lazy, cloned]) {
			const rebuilt = materializeDto(captureDto(schema))
			expect(rebuilt.safeParse({ filters: { title: 'a' }, limit: 1 }).success).toBe(
				schema.safeParse({ filters: { title: 'a' }, limit: 1 }).success,
			)
			expect(rebuilt.safeParse({ filters: { title: 1 }, limit: 1 }).success).toBe(false)
			expect(z.toJSONSchema(rebuilt)).toEqual(z.toJSONSchema(schema))
		}
	})

	test('a caller-owned accessor in a definition is still rejected', () => {
		const foreign = new z.ZodOptional({
			type: 'optional',
			get innerType() {
				return z.string()
			},
		})
		expect(() => captureDto(z.object({ field: foreign }))).toThrow(
			'Unsupported DTO schema accessor',
		)
	})
})
