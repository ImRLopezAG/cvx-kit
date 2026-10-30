import { expect, test } from 'vite-plus/test'
import { z } from 'zod'
import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { captureDto, materializeDto } from '../src/querying/schema-snapshot'
import { defineRelations, getRelationExecutor, verifyRelations } from '../src/relations'
import { zid, zodTable, zodToConvex } from '../src/zod-table'

function nativeJson(validator: GenericValidator): ValidatorJSON {
	// SAFETY: Convex exposes converter JSON at runtime but omits it from public declarations.
	return (validator as GenericValidator & { json: ValidatorJSON }).json
}

function registryFor(dto: z.ZodObject) {
	const items = zodTable('items', () => ({ value: z.string() }))
	Reflect.set(items, 'dto', () => dto)
	return defineRelations({ items }, () => ({}))
}

test('U1 public object shape divergence preserves captured conversion and full identity', () => {
	const nested = z.object({ visible: z.string() })
	void nested.shape
	Object.defineProperty(nested, 'shape', {
		value: { visible: z.number() },
		configurable: true,
	})
	const source = z.object({ nested })
	const restored = materializeDto(captureDto(source))
	expect(nativeJson(zodToConvex(source))).not.toEqual(nativeJson(zodToConvex(restored)))
	const registry = registryFor(source)
	const equivalent = registryFor(z.object({ nested: z.object({ visible: z.number() }) }))
	expect(registry.identity).toBe(equivalent.identity)
	expect(registry.identity).not.toBe(
		registryFor(z.object({ nested: z.object({ visible: z.string() }) })).identity,
	)
	const row = { nested: { visible: 42 } }
	expect(getRelationExecutor(registry).project('items', row, () => true)).toEqual(row)
	expect(() =>
		getRelationExecutor(registry).project('items', { nested: { visible: 'text' } }, () => true),
	).toThrow()
	const page = { page: [row], isDone: true, continueCursor: '' }
	expect(registry.tables.items.pageDto({}).parse(page)).toEqual(page)
})

test('U1 top-level public shape divergence also participates in canonical identity', () => {
	const source = z.object({ original: z.string() })
	void source.shape
	Object.defineProperty(source, 'shape', {
		value: { captured: z.number().optional() },
		configurable: true,
	})
	expect(nativeJson(zodToConvex(source))).not.toEqual(
		nativeJson(zodToConvex(materializeDto(captureDto(source)))),
	)
	expect(registryFor(source).identity).toBe(
		registryFor(z.object({ captured: z.number().optional() })).identity,
	)
})

test('U1 refined native IDs preserve source/restored brands, optionality and parser checks', () => {
	const id = zid('items').refine((value) => value !== 'items:denied')
	const source = z.object({
		id,
		optional: id.optional(),
		nullable: id.nullable(),
		union: z
			.union([id, zid('other')])
			.nullable()
			.optional(),
		nested: z.array(z.object({ id })),
	})
	const restored = materializeDto(captureDto(source))
	expect(nativeJson(zodToConvex(source))).toEqual(nativeJson(zodToConvex(restored)))
	const good = { id: 'items:ok', nullable: null, nested: [{ id: 'items:ok' }] }
	expect(source.parse(good)).toEqual(restored.parse(good))
	expect(source.safeParse({ ...good, id: 'items:denied' }).success).toBe(false)
	expect(restored.safeParse({ ...good, id: 'items:denied' }).success).toBe(false)
	expect(registryFor(source).identity).toBe(registryFor(restored).identity)
})

test('U1 variant tag and nested-container conversion agrees for ordinary captured definitions', () => {
	const source = z.discriminatedUnion('kind', [
		z.object({
			kind: z.literal('one'),
			values: z.array(z.string().optional().nullable()).optional(),
		}),
		z.object({ kind: z.literal('two'), value: z.number().nullable() }),
	])
	// Arrays of optional values are rejected by both conversion routes.
	expect(() => zodToConvex(source)).toThrow('Arrays of optional values are not supported')
	expect(() => zodToConvex(materializeDto(captureDto(source)))).toThrow(
		'Arrays of optional values are not supported',
	)
	const supported = z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('one'), values: z.array(z.string().nullable()).optional() }),
		z.object({ kind: z.literal('two'), value: z.number().nullable() }),
	])
	const restored = materializeDto(captureDto(supported))
	expect(nativeJson(zodToConvex(supported))).toEqual(nativeJson(zodToConvex(restored)))
	expect(restored.parse({ kind: 'one', values: [null, 'ok'] })).toEqual(
		supported.parse({ kind: 'one', values: [null, 'ok'] }),
	)
})

test('U1 constructor-rejected UUID definition fails on first use despite source conversion success', () => {
	const uuid = z.uuid()
	Reflect.set(uuid._zod.def, 'version', 'invalid')
	const dto = z.object({ value: uuid })
	expect(nativeJson(zodToConvex(dto))).toEqual(
		nativeJson(zodToConvex(z.object({ value: z.string() }))),
	)
	const recipe = captureDto(dto)
	expect(() => materializeDto(recipe)).toThrow('Invalid UUID version: "invalid"')
	const items = zodTable('items', () => ({ value: z.string() }))
	Reflect.set(items, 'dto', () => dto)
	let declared = false
	const registry = defineRelations({ items }, () => {
		declared = true
		return {}
	})
	// Per-table capture is deferred to first use; declaration no longer waits for it.
	expect(declared).toBe(true)
	expect(() => registry.tables.items.pageDto({})).toThrow('Invalid UUID version: "invalid"')
	expect(() => verifyRelations(registry)).toThrow('Invalid UUID version: "invalid"')
})

test('U1 continuation constructor failure precedes bad indexes on first use', () => {
	const uuid = z.uuid()
	Reflect.set(uuid._zod.def, 'version', 'invalid')
	const items = zodTable('items', () => ({ value: z.string() }))
	Reflect.set(items, 'dto', () => z.object({ value: uuid }))
	Reflect.set(items.table, 'indexes', [{ indexDescriptor: 42, fields: [] }])
	const registry = defineRelations({ items }, () => ({}))
	expect(() => registry.tables.items.paginationOpts({})).toThrow('Invalid UUID version')
})

test('U1 continuation hidden constructor-sensitive catchall fails on first use', () => {
	const uuid = z.uuid()
	Reflect.set(uuid._zod.def, 'version', 'invalid')
	const registry = registryFor(z.object({ value: z.string() }).catchall(uuid))
	expect(() => registry.tables.items.pageDto({})).toThrow('Invalid UUID version')
})

test('U1 continuation configured constructor hook is observed on first use', () => {
	const dto = z.object({ value: z.string() })
	const items = zodTable('items', () => ({ value: z.string() }))
	const previous = z.config().postProcessor
	Reflect.set(items, 'dto', () => {
		z.config({
			postProcessor: () => {
				throw new Error('admission hook')
			},
		})
		return dto
	})
	try {
		const registry = defineRelations({ items }, () => ({}))
		expect(() => registry.tables.items.pageDto({})).toThrow('admission hook')
	} finally {
		z.config({ postProcessor: previous })
	}
})

test('U1 continuation captured IDs and optional union order survive source mutation', () => {
	const source = z.object({ value: z.union([zid('items'), zid('other').optional()]).nullable() })
	const registry = registryFor(source)
	const identity = registry.identity
	Reflect.set(source.shape, 'value', z.number())
	expect(registry.identity).toBe(identity)
	expect(
		registry.tables.items
			.pageDto({})
			.parse({ page: [{ value: null }], isDone: true, continueCursor: '' }).page,
	).toEqual([{ value: null }])
	expect(registryFor(source).identity).not.toBe(identity)
})

test('U1 continuation compatibility retains the later identity conversion after first use', () => {
	const source = z.object({ value: z.string() })
	const items = zodTable('items', () => ({ value: z.string() }))
	const previous = z.config().postProcessor
	let restored: z.ZodObject | undefined
	Reflect.set(items, 'dto', () => {
		z.config({
			postProcessor: (schema) => {
				if (schema instanceof z.ZodObject && Object.hasOwn(schema.shape, 'value')) restored = schema
			},
		})
		return source
	})
	const registry = defineRelations({ items }, () => ({}))
	try {
		// First use captures the DTO; identity converts the restored schema later.
		getRelationExecutor(registry).select('items', {})
		expect(restored).toBeDefined()
		Reflect.set(restored!.shape, 'value', z.number())
	} finally {
		z.config({ postProcessor: previous })
	}
	expect(registry.identity).toBe(registryFor(z.object({ value: z.number() })).identity)
	expect(getRelationExecutor(registry).project('items', { value: 42 }, () => true)).toEqual({
		value: 42,
	})
})

test('U3 full identity binds unused exposure independently of private materialization order', () => {
	function pair(exposeOther = true) {
		const items = zodTable('items', () => ({ value: z.string() }), { publicFields: ['value'] })
		const other = zodTable('other', () => ({ label: z.string() }), {
			publicFields: exposeOther ? ['label'] : [],
		})
		return defineRelations({ items, other }, () => ({}))
	}
	const left = pair(),
		right = pair(),
		before = left.identity
	getRelationExecutor(left).project('other', { _id: 'other:1', label: 'other' }, () => true)
	getRelationExecutor(left).project('items', { _id: 'items:1', value: 'item' }, () => true)
	getRelationExecutor(right).project('items', { _id: 'items:1', value: 'item' }, () => true)
	getRelationExecutor(right).project('other', { _id: 'other:1', label: 'other' }, () => true)
	expect(left.identity).toBe(before)
	expect(right.identity).toBe(before)
	expect(pair(false).identity).not.toBe(before)
})
