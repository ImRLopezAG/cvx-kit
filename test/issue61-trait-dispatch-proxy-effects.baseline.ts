import { expect, test } from 'vite-plus/test'
import { z } from 'zod'
import { captureDto, materializeDto } from '../src/querying/schema-snapshot'
import { defineRelations, getRelationExecutor } from '../src/relations'
import { zodTable } from '../src/zod-table'

function schemaWithObservableTraitsDescriptor() {
	const original = z.string()
	const events: string[] = []
	const internals = new Proxy(original._zod, {
		getOwnPropertyDescriptor(target, key) {
			events.push(String(key))
			if (key === 'traits') {
				target.traits.add('ZodNumber')
				throw new Error('caller traits descriptor trap')
			}
			return Reflect.getOwnPropertyDescriptor(target, key)
		},
	})
	const descriptors = Object.getOwnPropertyDescriptors(original)
	descriptors._zod = { ...descriptors._zod, value: internals }
	// SAFETY: preserve every installed schema descriptor and prototype; only the
	// caller-owned internals reader gains the observable descriptor trap.
	const schema = Object.create(Object.getPrototypeOf(original), descriptors) as z.ZodString
	return { schema, events }
}

test('issue61 capture does not inspect the caller traits descriptor before dispatch', () => {
	const { schema, events } = schemaWithObservableTraitsDescriptor()
	const recipe = captureDto(schema)
	expect(events).toEqual([])
	expect(recipe.root).toMatchObject({ kind: 'node', constructor: 'string' })
	const restored = materializeDto(recipe)
	expect(restored.safeParse('text').success).toBe(true)
	expect(restored.safeParse(42).success).toBe(false)
})

test('issue61 admitted proxy internals retain registry identity and private string parsing', () => {
	function registry(schema: z.ZodType) {
		const items = zodTable('items', () => ({ value: z.string() }), { publicFields: ['value'] })
		Reflect.set(items, 'dto', () => z.object({ value: schema }))
		return defineRelations({ items }, () => ({}))
	}
	const { schema, events } = schemaWithObservableTraitsDescriptor()
	const actual = registry(schema)
	expect(events).not.toContain('traits')
	expect(actual.identity).toBe(registry(z.string()).identity)
	expect(actual.identity).not.toBe(registry(z.number()).identity)
	const executor = getRelationExecutor(actual)
	expect(executor.project('items', { value: 'text' }, () => true)).toEqual({ value: 'text' })
	expect(() => executor.project('items', { value: 42 }, () => true)).toThrow()
	expect(events).not.toContain('traits')
})
