import { expect, test } from 'vite-plus/test'
import { z } from 'zod'
import type { Value } from 'convex/values'
import { defineRelations, getRelationExecutor } from '../src/relations'
import { zodVariantTable } from '../src/zod-table'

test('variant extraction snapshots own fields before getters and reads current values on every call', () => {
	const items = zodVariantTable(
		'items',
		z.discriminatedUnion('type', [
			z.strictObject({
				type: z.literal('entry'),
				first: z.string(),
				later: z.string().optional(),
			}),
		]),
		{ discriminator: 'type', variants: { entry: { publicFields: ['first'] } } },
	)
	const executor = getRelationExecutor(defineRelations({ items }, () => ({})))
	for (const initiallyOwn of [false, true]) {
		const events: string[] = []
		const target: Record<string, Value> = {
			type: 'entry',
			get first() {
				events.push('first getter')
				Reflect.set(target, 'later', 42)
				return 'valid'
			},
			...(initiallyOwn ? { later: 'valid' } : {}),
			_id: 'items:1',
			_creationTime: 1,
		}
		const row = new Proxy(target, {
			getOwnPropertyDescriptor(object, key) {
				events.push(`own ${String(key)}`)
				return Reflect.getOwnPropertyDescriptor(object, key)
			},
			get(object, key) {
				events.push(`get ${String(key)}`)
				return Reflect.get(object, key)
			},
		})
		if (initiallyOwn) expect(() => executor.validateDocument('items', row)).toThrow()
		else executor.validateDocument('items', row)
		expect(events.indexOf('own later')).toBeLessThan(events.indexOf('first getter'))
		expect(events.includes('get later')).toBe(initiallyOwn)
		// The same object now owns an invalid field, even if the earlier call omitted it.
		expect(() => executor.validateDocument('items', row)).toThrow()
	}
})

test('variant extraction still reads fields deleted by an earlier getter', () => {
	const items = zodVariantTable(
		'items',
		z.discriminatedUnion('type', [
			z.strictObject({ type: z.literal('entry'), first: z.string(), later: z.string().optional() }),
		]),
		{ discriminator: 'type', variants: { entry: { publicFields: ['first'] } } },
	)
	const executor = getRelationExecutor(defineRelations({ items }, () => ({})))
	const row = {
		type: 'entry',
		get first() {
			Reflect.deleteProperty(row, 'later')
			return 'valid'
		},
		later: 'own value',
		_id: 'items:1',
		_creationTime: 1,
	}
	Object.setPrototypeOf(row, { later: 42 })
	expect(() => executor.validateDocument('items', row)).toThrow()
})
