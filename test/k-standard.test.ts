import type { StandardSchemaV1 } from '@standard-schema/spec'
import { describe, expect, it } from 'vitest'
import { k } from '../src/k'
import { standardContract } from '../src/modules/contracts/standard'

describe('k Standard Schema', () => {
	const schema = k.object({ name: k.string().trim().min(1), tags: k.array(k.string()).optional() })

	it('validates through ~standard with values and issue paths', () => {
		const props = schema['~standard']
		expect(props.version).toBe(1)
		expect(props.vendor).toBe('cvx-kit')
		expect(props.validate({ name: ' a ' })).toEqual({ value: { name: 'a' } })
		expect(props.validate({ name: ' ', tags: [1] })).toEqual({
			issues: [
				{ path: ['name'], message: expect.any(String) },
				{ path: ['tags', 0], message: expect.any(String) },
			],
		})
	})

	it('keeps ~standard on the shared prototype, not on instances', () => {
		expect(Object.hasOwn(schema, '~standard')).toBe(false)
		expect(Object.keys(schema)).not.toContain('~standard')
	})

	it('is accepted by standardContract', async () => {
		const contract = standardContract(schema)
		expect(await contract.decode({ name: 'x' })).toEqual({ value: { name: 'x' } })
		const input: StandardSchemaV1.InferInput<typeof schema> = { name: 'x' }
		expect(input.name).toBe('x')
	})

	it('records describe as one chain record without changing validators or parsing', () => {
		const described = k.string().min(1).describe('A name')
		expect(described.op).toBe('describe')
		expect(described.description).toBe('A name')
		expect(described.optional().description).toBe('A name')
		expect(described.validator).toBe(k.string().validator)
		expect(described.safeParse('').success).toBe(false)
		expect(described.parse('a')).toBe('a')
	})

	it('fails .toZod() with the entry name when cvx-kit/zod is not imported', () => {
		// This file never imports src/zod.ts, so the core stub is still installed; the type comes from the
		// repository-wide augmentation in src/zod.ts.
		expect(() => schema.toZod()).toThrow(/cvx-kit\/zod/)
	})
})
