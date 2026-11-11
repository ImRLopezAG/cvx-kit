import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { z } from 'zod'
import { defineRelations } from '../src/relations'
import { createModule, createTable, tenantTable, zodTable, zodVariantTable } from '../src/zod-table'

const conversions = vi.hoisted(() => ({ count: 0 }))

vi.mock('../src/zod-convex', async (importOriginal) => {
	const original = await importOriginal<typeof import('../src/zod-convex')>()
	return {
		...original,
		zodToConvex: (...input: Parameters<typeof original.zodToConvex>) => {
			conversions.count++
			return original.zodToConvex(...input)
		},
	}
})

beforeEach(() => {
	conversions.count = 0
})

const withShared = createTable({ label: z.string() })

function plain() {
	return zodTable('posts', (id) => ({ authorId: id('users'), title: z.string() }), {
		publicFields: ['title'],
	})
}
function tenant() {
	return tenantTable('notes', () => ({ body: z.string() }))
}
function shared() {
	return withShared('tags', () => ({ weight: z.number() }))
}
const variantStorage = z.discriminatedUnion('type', [
	z.strictObject({ type: z.literal('a'), amount: z.number() }),
	z.strictObject({ type: z.literal('b'), note: z.string() }),
])
function legacyVariant() {
	return zodVariantTable('events', variantStorage)
}
function derivedVariant() {
	return zodVariantTable('ledger', variantStorage, {
		discriminator: 'type',
		timestamps: true,
		variants: { a: { publicFields: ['amount'] }, b: { publicFields: ['note'] } },
	})
}
const constructors = { plain, tenant, shared, legacyVariant, derivedVariant }

describe('deferred native table definition', () => {
	it('serializes the same schema, indexes included, for every table constructor', () => {
		const tables = {
			posts: plain().table.index('by_authorId', ['authorId']),
			notes: tenant().table.index('by_tenant', ['tenant']),
			tags: shared().table,
			events: legacyVariant().table.index('by_type', ['type']),
			ledger: derivedVariant().table,
		}
		expect(JSON.stringify(defineSchema(tables))).toMatchInlineSnapshot(
			`"{"tables":{"posts":{"indexes":[{"indexDescriptor":"by_authorId","fields":["authorId"]}],"stagedDbIndexes":[],"searchIndexes":[],"stagedSearchIndexes":[],"vectorIndexes":[],"stagedVectorIndexes":[],"validator":{"isOptional":"required","isConvexValidator":true,"fields":{"authorId":{"isOptional":"required","isConvexValidator":true,"tableName":"users","kind":"id"},"title":{"isOptional":"required","isConvexValidator":true,"kind":"string"},"createdAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"},"updatedAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"},"archivedAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"}},"kind":"object"}},"notes":{"indexes":[{"indexDescriptor":"by_tenant","fields":["tenant"]}],"stagedDbIndexes":[],"searchIndexes":[],"stagedSearchIndexes":[],"vectorIndexes":[],"stagedVectorIndexes":[],"validator":{"isOptional":"required","isConvexValidator":true,"fields":{"body":{"isOptional":"required","isConvexValidator":true,"kind":"string"},"tenant":{"isOptional":"required","isConvexValidator":true,"kind":"string"},"createdAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"},"updatedAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"},"archivedAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"}},"kind":"object"}},"tags":{"indexes":[],"stagedDbIndexes":[],"searchIndexes":[],"stagedSearchIndexes":[],"vectorIndexes":[],"stagedVectorIndexes":[],"validator":{"isOptional":"required","isConvexValidator":true,"fields":{"label":{"isOptional":"required","isConvexValidator":true,"kind":"string"},"weight":{"isOptional":"required","isConvexValidator":true,"kind":"float64"},"createdAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"},"updatedAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"},"archivedAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"}},"kind":"object"}},"events":{"indexes":[{"indexDescriptor":"by_type","fields":["type"]}],"stagedDbIndexes":[],"searchIndexes":[],"stagedSearchIndexes":[],"vectorIndexes":[],"stagedVectorIndexes":[],"validator":{"isOptional":"required","isConvexValidator":true,"members":[{"isOptional":"required","isConvexValidator":true,"fields":{"type":{"isOptional":"required","isConvexValidator":true,"value":"a","kind":"literal"},"amount":{"isOptional":"required","isConvexValidator":true,"kind":"float64"}},"kind":"object"},{"isOptional":"required","isConvexValidator":true,"fields":{"type":{"isOptional":"required","isConvexValidator":true,"value":"b","kind":"literal"},"note":{"isOptional":"required","isConvexValidator":true,"kind":"string"}},"kind":"object"}],"kind":"union"}},"ledger":{"indexes":[],"stagedDbIndexes":[],"searchIndexes":[],"stagedSearchIndexes":[],"vectorIndexes":[],"stagedVectorIndexes":[],"validator":{"isOptional":"required","isConvexValidator":true,"members":[{"isOptional":"required","isConvexValidator":true,"fields":{"type":{"isOptional":"required","isConvexValidator":true,"value":"a","kind":"literal"},"amount":{"isOptional":"required","isConvexValidator":true,"kind":"float64"},"createdAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"},"updatedAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"},"archivedAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"}},"kind":"object"},{"isOptional":"required","isConvexValidator":true,"fields":{"type":{"isOptional":"required","isConvexValidator":true,"value":"b","kind":"literal"},"note":{"isOptional":"required","isConvexValidator":true,"kind":"string"},"createdAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"},"updatedAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"},"archivedAt":{"isOptional":"optional","isConvexValidator":true,"kind":"float64"}},"kind":"object"}],"kind":"union"}}},"schemaValidation":true}"`,
		)
	})

	it.each(Object.entries(constructors))(
		'%s converts nothing until .table is first read, then reuses it',
		(_, make) => {
			const boundary = make()
			expect(conversions.count).toBe(0)
			const table = boundary.table
			expect(conversions.count).toBe(1)
			expect(boundary.table).toBe(table)
			expect(conversions.count).toBe(1)
		},
	)

	it.each(Object.entries(constructors))('%s replaces .table on assignment', (_, make) => {
		const boundary = make()
		const replacement = defineTable({ other: v.string() })
		// The replacement intentionally differs from the inferred table type.
		Reflect.set(boundary, 'table', replacement)
		expect(boundary.table).toBe(replacement)
		expect(Object.getOwnPropertyDescriptor(boundary, 'table')).toEqual({
			value: replacement,
			writable: true,
			enumerable: true,
			configurable: true,
		})
		expect(conversions.count).toBe(0)
	})

	it('reports unsupported storage on the first .table read with the conversion message', () => {
		const boundary = zodTable('lists', () => ({ items: z.array(z.string().optional()) }))
		expect(() => boundary.table).toThrow('Arrays of optional values are not supported')
		const variant = zodVariantTable(
			'lists',
			z.discriminatedUnion('type', [
				z.object({ type: z.literal('a'), items: z.array(z.string().optional()) }),
			]),
		)
		expect(() => variant.table).toThrow('Arrays of optional values are not supported')
	})

	it('composes modules into a schema', () => {
		const posts = plain()
		const notes = tenant()
		const module = createModule({ posts: posts.table }, { notes: notes.table })
		expect(module.posts).toBe(posts.table)
		expect(Object.keys(defineSchema(module).tables)).toEqual(['posts', 'notes'])
	})

	it('defineRelations converts a table only on its first relation use', () => {
		const posts = plain()
		const registry = defineRelations({ posts }, () => ({}))
		expect(conversions.count).toBe(0)
		registry.tables.posts.pageDto({})
		expect(conversions.count).toBeGreaterThan(0)
	})

	it('defineRelations still rejects a foreign table getter', () => {
		const posts = plain()
		const native = posts.table
		Object.defineProperty(posts, 'table', { get: () => native, configurable: true })
		expect(() => defineRelations({ posts }, () => ({}))).toThrow(
			'Unsupported native table accessor',
		)
	})
})
