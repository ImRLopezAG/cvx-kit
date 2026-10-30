import { describe, expect, test } from 'vite-plus/test'
import { z } from 'zod'
import {
	defineRelations,
	getRelationExecutor,
	getRelationMetadata,
	verifyRelations,
	type RelationRegistryIdentity,
	type RelationTables,
} from '../src/relations'
import { zodTable, zodVariantTable } from '../src/zod-table'
import { defineTables, register } from '../scripts/bench/relations-fixture'

/** The untyped runtime helper surface: these registries use generated table names. */
interface RuntimeRegistry extends RelationRegistryIdentity {
	tables: Record<
		string,
		{
			paginationOpts(selection: object): unknown
			pageDto(selection: object, groups?: object): unknown
			filters(contract: object): unknown
		}
	>
}
type RuntimeBuilder = Record<string, any>
// SAFETY: runtime registration is identical for generated names; only the static types are erased.
const unchecked = defineRelations as unknown as (
	tables: RelationTables,
	declare: (r: RuntimeBuilder, branch: (table: string, tag: string) => RuntimeBuilder) => object,
) => RuntimeRegistry

/** Counts DTO captures and stored-schema reads per table without changing either. */
function observed(tables: Record<string, { dto: (includeId: true) => unknown; schema: unknown }>) {
	const dto: Record<string, number> = {}
	const stored: Record<string, number> = {}
	for (const [name, table] of Object.entries(tables)) {
		dto[name] = 0
		stored[name] = 0
		const original = table.dto
		const schema = table.schema
		Reflect.set(table, 'dto', (includeId: true) => {
			dto[name]++
			return original(includeId)
		})
		Object.defineProperty(table, 'schema', {
			get: () => {
				stored[name]++
				return schema
			},
		})
	}
	const touched = (counts: Record<string, number>) =>
		Object.keys(counts).filter((name) => counts[name] > 0)
	return { dto: () => touched(dto), stored: () => touched(stored) }
}

function chain() {
	const tables = Object.fromEntries(
		Array.from({ length: 12 }, (_, i) => {
			const table = zodTable(
				`t${i}`,
				(id) => ({ parentId: id(`t${Math.max(0, i - 1)}`), code: z.string() }),
				{
					publicFields: ['parentId', 'code'],
				},
			)
			table.table.index('by_parentId', ['parentId'])
			return [`t${i}`, table]
		}),
	)
	const seen = observed(tables)
	const registry = unchecked(tables, (r) =>
		Object.fromEntries(
			Array.from({ length: 11 }, (_, i) => [
				`t${i + 1}`,
				{ parent: r.one[`t${i}`]({ from: r[`t${i + 1}`].parentId, to: r[`t${i}`]._id }) },
			]),
		),
	)
	return { registry, seen }
}

describe('lazy per-table registration', () => {
	test('registration materializes no table, and one table pays only for itself', () => {
		const { registry, seen } = chain()
		expect(seen.dto()).toEqual([])
		expect(seen.stored()).toEqual([])
		registry.tables.t5.paginationOpts({ code: true })
		expect(seen.dto()).toEqual(['t5'])
		expect(seen.stored()).toEqual(['t5'])
	})

	test('selected relations reach their targets; unselected edges stay unread', () => {
		const { registry, seen } = chain()
		registry.tables.t5.pageDto({ parent: true })
		// The edge needs t4's stored tier; the selected row schema needs its DTO.
		expect(seen.dto()).toEqual(['t4', 't5'])
		expect(seen.stored()).toEqual(['t4', 't5'])
		registry.tables.t8.paginationOpts({ parent: { code: true } })
		expect(seen.dto()).toEqual(['t4', 't5', 't7', 't8'])
	})

	test('each table materializes once, whichever path reaches it first', () => {
		const { registry, seen } = chain()
		registry.tables.t3.pageDto({ parent: true })
		registry.tables.t2.pageDto({})
		registry.tables.t3.paginationOpts({ parent: { code: true } })
		const executor = getRelationExecutor(registry)
		executor.project('t2', { _id: 't2:1', parentId: 't1:1', code: 'x' }, () => true)
		expect(seen.dto()).toEqual(['t2', 't3'])
		expect(seen.stored()).toEqual(['t2', 't3'])
	})

	test('metadata snapshots, stream schema and executor reads are per table', () => {
		const { registry, seen } = chain()
		expect(getRelationMetadata(registry).tables.t6.indexes).toEqual([
			{ name: 'by_parentId', fields: ['parentId'] },
		])
		const stream = getRelationExecutor(registry).streamSchema.tables.t7
		expect(Object.getOwnPropertyDescriptor(stream, 'indexes')?.value).toHaveLength(1)
		expect(seen.dto()).toEqual(['t6', 't7'])
		expect(Object.hasOwn(getRelationMetadata(registry).tables, 't9')).toBe(true)
		expect(seen.dto()).toEqual(['t6', 't7'])
	})

	test('identity and verifyRelations materialize everything and agree with the eager form', () => {
		const lazy = chain()
		const touched = chain()
		touched.registry.tables.t11.pageDto({ parent: { parent: true } })
		getRelationExecutor(touched.registry).pagination('t3')
		expect(touched.registry.identity).toBe(lazy.registry.identity)
		expect(lazy.seen.dto()).toHaveLength(12)
		const verified = chain()
		verifyRelations(verified.registry)
		expect(verified.seen.dto()).toHaveLength(12)
		expect(verified.registry.identity).toBe(lazy.registry.identity)
		expect(() => verifyRelations({ identity: lazy.registry.identity, version: 1 })).toThrow(
			'Unknown relation registry',
		)
	})

	test('the benchmark registry registers without materializing any table', () => {
		const tables = defineTables()
		const seen = observed(tables.tables)
		const registry = register(tables)
		expect(seen.dto()).toEqual([])
		// Only the variant table's discriminator is read, by descriptor.
		expect(seen.stored()).toEqual(['payments'])
		registry.tables.tasks.paginationOpts({ status: true })
		expect(seen.dto()).toEqual(['tasks'])
	})
})

describe('deferred checks still throw no later than first use', () => {
	function invalid() {
		const good = zodTable('good', () => ({ code: z.string() }), { publicFields: ['code'] })
		const bad = zodTable('bad', () => ({ text: z.string().superRefine(() => {}) }), {
			publicFields: ['text'],
		})
		return { good, bad }
	}

	test('a per-table error surfaces on every first-use path, and is cached', () => {
		const registry = unchecked(invalid(), () => ({}))
		expect(registry.tables.good.pageDto({})).toBeDefined()
		const uses: (() => unknown)[] = [
			() => registry.tables.bad.pageDto({}),
			() => registry.tables.bad.paginationOpts({}),
			() => registry.tables.bad.filters({ native: {}, schema: z.object({}) }),
			() => getRelationExecutor(registry).pagination('bad'),
			() => getRelationExecutor(registry).select('bad', {}),
			() => getRelationExecutor(registry).groups('bad', {}),
			() => getRelationExecutor(registry).validateDocument('bad', {}),
			() => getRelationExecutor(registry).project('bad', {}, () => true),
			() => getRelationMetadata(registry).tables.bad,
			() => getRelationExecutor(registry).streamSchema.tables.bad,
			() => registry.identity,
			() => verifyRelations(registry),
		]
		let first: unknown
		for (const use of uses) {
			let thrown: unknown
			try {
				use()
			} catch (error) {
				thrown = error
			}
			expect(String(thrown)).toMatch(/opaque.*refine/i)
			first ??= thrown
			expect(thrown).toBe(first)
		}
	})

	test('an invalid edge throws when read, when the engine walks it, and on verification', () => {
		const owners = zodTable('owners', () => ({ code: z.string() }), { publicFields: ['code'] })
		const children = zodTable('children', () => ({ owner: z.string() }), {
			publicFields: ['owner'],
		})
		const registry = unchecked({ owners, children }, (r) => ({
			owners: { children: r.many.children({ from: r.owners.code, to: r.children.owner }) },
		}))
		expect(registry.tables.owners.paginationOpts({ code: true })).toBeDefined()
		expect(() => registry.tables.owners.pageDto({ children: true })).toThrow(/active index begins/)
		expect(() => getRelationExecutor(registry).pagination('owners')).toThrow(/active index begins/)
		expect(() => getRelationMetadata(registry).declarations.owners.children).toThrow(
			/active index begins/,
		)
		expect(() => registry.identity).toThrow(/active index begins/)
		expect(() => verifyRelations(registry)).toThrow(/active index begins/)
	})

	test('an invalid edge target fails the edge without failing unrelated tables', () => {
		const { good, bad } = invalid()
		const owners = zodTable('owners', (id) => ({ badId: id('bad') }), { publicFields: ['badId'] })
		bad.table.index('by_text', ['text'])
		const registry = unchecked({ good, bad, owners }, (r) => ({
			owners: { bad: r.one.bad({ from: r.owners.badId, to: r.bad._id }) },
		}))
		expect(registry.tables.owners.pageDto({})).toBeDefined()
		// The edge itself is valid; selecting it materializes the invalid target.
		expect(() => registry.tables.owners.pageDto({ bad: true })).toThrow(/opaque.*refine/i)
		expect(registry.tables.good.pageDto({})).toBeDefined()
	})

	test('forTable and through checks on a field throw on first use of the owning table', () => {
		const a = zodTable('a', () => ({ code: z.string() }), { publicFields: ['code'] })
		const b = zodTable('b', () => ({ code: z.string() }), { publicFields: ['code'] })
		const links = zodTable('links', (id) => ({ a: id('a'), b: z.number() }), {
			publicFields: ['a'],
		})
		const member = unchecked({ a, b, links }, (r) => {
			r.links.a.forTable('a')
			r.links.b.forTable('a')
			return {}
		})
		expect(member.tables.a.pageDto({})).toBeDefined()
		expect(() => member.tables.links.pageDto({})).toThrow('Invalid native ID member selection')
		const through = unchecked({ a, b, links }, (r) => {
			r.a.code.through(r.links.a)
			return {}
		})
		expect(through.tables.b.pageDto({})).toBeDefined()
		expect(() => through.tables.a.pageDto({})).toThrow('Invalid junction field or registry')
		expect(() => verifyRelations(through)).toThrow('Invalid junction field or registry')
	})

	test('structural errors still throw at registration', () => {
		const { good } = invalid()
		const other = zodTable('other', () => ({ code: z.string() }), { publicFields: ['code'] })
		const cases: [RelationTables, Parameters<typeof unchecked>[1], RegExp | string][] = [
			[{ wrong: good }, () => ({}), 'Invalid relation table "wrong"'],
			[{ good }, () => ({ missing: {} }), 'Unknown source table "missing"'],
			[
				{ good, other },
				(r) => ({ good: { code: r.one.other({ from: r.good._id, to: r.other._id }) } }),
				'Relation name collision "code"',
			],
			[
				{ good, other },
				(r) => ({ other: { x: r.one.other({ from: r.good._id, to: r.other._id }) } }),
				'Relation source bucket mismatch',
			],
			[
				{ good, other },
				(r) => ({ good: { x: r.one.other({ from: r.good._id, to: r.good._id }) } }),
				'Wrong relation target table',
			],
			[
				{ good, other },
				(r) => ({
					good: { x: r.one.other({ from: r.good._id, to: r.other.code.through(r.good.code) }) },
				}),
				'Both relation legs must use through',
			],
			[{ good }, (_, branch) => (branch('good', 'x'), {}), 'Unknown variant scope "good.x"'],
			[
				{ good, other },
				(r) => (r.good.code.forTable('nowhere'), {}),
				'Native ID member table is not registered',
			],
		]
		for (const [tables, declare, error] of cases)
			expect(() => unchecked(tables, declare)).toThrow(error)
		const accessor = { ...good }
		Object.defineProperty(accessor, 'table', { get: () => good.table, enumerable: true })
		expect(() => unchecked({ good: accessor }, () => ({}))).toThrow(
			'Unsupported native table accessor',
		)
	})

	test('variant references come from the preflighted native union without materializing it', () => {
		const owners = zodTable('owners', () => ({ code: z.string() }), { publicFields: ['code'] })
		const payments = zodVariantTable(
			'payments',
			z.discriminatedUnion('type', [
				z.strictObject({ type: z.literal('card'), ownerId: z.string(), extra: z.string() }),
				z.strictObject({ type: z.literal('wire'), ownerId: z.string(), extra: z.number() }),
			]),
			{
				discriminator: 'type',
				variants: { card: { publicFields: ['ownerId'] }, wire: { publicFields: ['ownerId'] } },
			},
		)
		payments.table.index('by_type_ownerId', ['type', 'ownerId'])
		let common: string[] = []
		let card: string[] = []
		const seen = observed({ owners, payments })
		const registry = unchecked({ owners, payments }, (r, branch) => {
			common = Object.keys(r.payments).sort()
			card = Object.keys(branch('payments', 'card')).sort()
			return {
				owners: {
					card: r.many.payments({ from: r.owners.code, to: branch('payments', 'card').ownerId }),
				},
			}
		})
		expect(seen.dto()).toEqual([])
		// Incompatible same-named fields are not common, exactly as after normalization.
		expect(common).toEqual(expect.arrayContaining(['_creationTime', '_id', 'ownerId', 'type']))
		expect(common).not.toContain('extra')
		expect(card).toEqual(
			expect.arrayContaining(['_creationTime', '_id', 'extra', 'ownerId', 'type']),
		)
		const materialized = getRelationMetadata(registry).tables.payments.fields
		expect(Object.keys(materialized).sort()).toEqual(common)
		expect(registry.tables.owners.pageDto({ card: true })).toBeDefined()
		expect(seen.dto()).toEqual(['owners', 'payments'])
	})
})
