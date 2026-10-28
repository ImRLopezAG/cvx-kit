import { expect, test } from 'vite-plus/test'
import { z } from 'zod'
import { captureDto, materializeDto } from '../src/querying/schema-snapshot'
import { defineRelations, getRelationExecutor } from '../src/relations'
import { zodTable } from '../src/zod-table'

function selected(schema: z.ZodType) {
	const root = captureDto(schema).root
	return root.kind === 'node' ? root.constructor : undefined
}

test('ordinary traits preserve reverse precedence across mutations and prototype transplants', () => {
	const schema = z.string()
	expect(selected(schema)).toBe('string')
	schema._zod.traits.add('unknown trait')
	schema._zod.traits.add('ZodNumber')
	expect(selected(schema)).toBe('number')
	schema._zod.traits.delete('ZodNumber')
	expect(selected(schema)).toBe('string')
	schema._zod.traits.delete('ZodString')
	expect(() => captureDto(schema)).toThrow('Unsupported DTO schema or check')
	const number = z.number()
	Object.setPrototypeOf(number, z.ZodString.prototype)
	expect(selected(number)).toBe('number')
	expect(materializeDto(captureDto(number)).safeParse(42).success).toBe(true)
})

test('ordinary dispatch never reads overridden iterators or forEach', () => {
	const schema = z.string()
	Object.defineProperties(schema._zod.traits, {
		[Symbol.iterator]: {
			get() {
				throw new Error('iterator read')
			},
		},
		forEach: {
			get() {
				throw new Error('forEach read')
			},
		},
	})
	expect(selected(schema)).toBe('string')
})

function customReader(kind: 'own' | 'accessor' | 'collection' | 'subclass', throws = false) {
	const schema = z.string()
	const events: string[] = []
	function has(name: string) {
		events.push(name)
		if (throws) throw new Error('custom has failure')
		return name === '$ZodType' || name === 'ZodString'
	}
	if (kind === 'collection') Reflect.set(schema._zod, 'traits', { has })
	else if (kind === 'subclass') {
		class Traits extends Set<string> {
			override has(name: string) {
				return has(name)
			}
		}
		schema._zod.traits = new Traits(schema._zod.traits)
	} else
		Object.defineProperty(
			schema._zod.traits,
			'has',
			kind === 'own'
				? { value: has }
				: {
						get() {
							events.push('get has')
							return has
						},
					},
		)
	return { schema, events }
}

for (const kind of ['own', 'accessor', 'collection', 'subclass'] as const) {
	test(`custom ${kind} has retains exact reverse-scan calls and errors`, () => {
		const { schema, events } = customReader(kind)
		expect(selected(schema)).toBe('string')
		const names = events.filter((name) => name !== 'get has')
		expect(names.slice(0, 2)).toEqual(['$ZodType', '$ZodCheck'])
		expect(names.slice(-2)).toEqual(['ZodCustom', 'ZodObject'])
		expect(names.filter((name) => name === 'ZodString')).toHaveLength(1)
		expect(names.indexOf('ZodNumber')).toBeLessThan(names.indexOf('ZodString'))
		if (kind === 'accessor') expect(events).toEqual(names.flatMap((name) => ['get has', name]))
		const failure = customReader(kind, true)
		expect(() => captureDto(failure.schema)).toThrow('custom has failure')
		expect(failure.events).toEqual(kind === 'accessor' ? ['get has', '$ZodType'] : ['$ZodType'])
	})
}

test('ordinary internal accessors retain original reads at the capture seam', () => {
	const original = z.string()
	const internal = original._zod
	const descriptors = Object.getOwnPropertyDescriptors(original)
	Reflect.deleteProperty(descriptors, '_zod')
	let reads = 0
	const schema: z.ZodString = Object.create(Object.getPrototypeOf(original), descriptors)
	Object.defineProperty(schema, '_zod', {
		get() {
			reads++
			return internal
		},
	})
	expect(selected(schema)).toBe('string')
	// Full scan repeats the same reader once per installed match plus the original
	// membership/custom/object/definition reads. Keep the exact installed oracle.
	const expected = String(z.core.version.minor) === '6' ? 87 : 84
	expect(reads).toBe(expected)
})

test('ordinary changed traits preserve full registry identity and private parsing', () => {
	function registry(value: z.ZodType) {
		const items = zodTable('items', () => ({ value: z.number() }), { publicFields: ['value'] })
		Reflect.set(items, 'dto', () => z.object({ value }))
		return defineRelations({ items }, () => ({}))
	}
	const value = z.string()
	value._zod.traits.add('ZodNumber')
	const result = registry(value)
	expect(result.identity).toBe(registry(z.number()).identity)
	expect(result.identity).not.toBe(registry(z.string()).identity)
	const executor = getRelationExecutor(result)
	expect(executor.project('items', { value: 3 }, () => true)).toEqual({ value: 3 })
	expect(() => executor.project('items', { value: 'text' }, () => true)).toThrow()
})
