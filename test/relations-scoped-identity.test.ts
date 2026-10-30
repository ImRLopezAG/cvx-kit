import { describe, expect, test } from 'vite-plus/test'
import { z } from 'zod'
import {
	defineRelations,
	getRelationExecutor,
	type RelationRegistryIdentity,
	type RelationTables,
} from '../src/relations'
import { zodTable } from '../src/zod-table'
import { createPlanner, digest, type RegistryScope } from '../src/querying/planner'
import { defineSchema } from 'convex/server'

type RuntimeBuilder = Record<string, any>
// SAFETY: runtime registration is identical for these names; only the static types are erased.
const unchecked = defineRelations as unknown as (
	tables: RelationTables,
	declare: (r: RuntimeBuilder) => object,
) => RelationRegistryIdentity

type Change =
	| 'none'
	| 'unrelated'
	| 'incoming'
	| 'brokenUnrelated'
	| 'target'
	| 'transitive'
	| 'junction'
	| 'edge'
	| 'root'

/** a -bs-> b (through links), b -c-> c, and z -a-> a; y is disconnected. */
function world(change: Change = 'none') {
	const captured: string[] = []
	function observe<T extends { dto: (includeId: true) => z.ZodType }>(name: string, table: T): T {
		const dto = table.dto
		Reflect.set(table, 'dto', (includeId: true) => {
			captured.push(name)
			return dto(includeId)
		})
		return table
	}
	const extra = (when: Change) => (change === when ? z.string() : z.string().optional())
	const a = observe(
		'a',
		zodTable('a', () => ({ code: z.string(), extra: extra('root') }), { publicFields: ['code'] }),
	)
	const b = observe(
		'b',
		zodTable('b', (id) => ({ code: z.string(), cId: id('c'), extra: extra('target') }), {
			publicFields: ['code'],
		}),
	)
	const c = observe(
		'c',
		zodTable('c', () => ({ code: z.string() }), { publicFields: ['code'] }),
	)
	const links = observe(
		'links',
		zodTable('links', () => ({ a: z.string(), b: z.string(), extra: extra('junction') }), {
			publicFields: ['a'],
		}),
	)
	const y = observe(
		'y',
		zodTable('y', () => ({ code: z.string(), extra: extra('unrelated') }), {
			publicFields: ['code'],
		}),
	)
	const zt = observe(
		'z',
		zodTable('z', (id) => ({ aId: id('a'), other: id('a') }), { publicFields: ['aId'] }),
	)
	links.table.index('by_a', ['a'])
	b.table.index('by_code', ['code'])
	if (change === 'transitive') c.table.index('by_code', ['code'])
	if (change === 'brokenUnrelated')
		Reflect.set(y, 'dto', () => z.object({ code: z.string().superRefine(() => {}) }))
	const tables = { a, b, c, links, y, z: zt }
	const registry = unchecked(tables, (r) => {
		const toA = { a: r.one.a({ from: r.z.aId, to: r.a._id }) }
		return {
			a: {
				[change === 'edge' ? 'items' : 'bs']: r.many.b({
					from: r.a.code.through(r.links.a),
					to: r.b.code.through(r.links.b),
				}),
			},
			b: { c: r.one.c({ from: r.b.cId, to: r.c._id }) },
			z: change === 'incoming' ? { ...toA, again: r.one.a({ from: r.z.other, to: r.a._id }) } : toA,
		}
	})
	const scoped = (tables: string[], edges: [string, string][] = []) =>
		getRelationExecutor(registry).scopedIdentity(tables, edges)
	const schema = defineSchema(
		Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, table.table])),
	)
	const version = (scope: Partial<RegistryScope>) =>
		createPlanner(schema, registry).registryVersion({
			root: 'a',
			path: [],
			selection: {},
			groups: { relations: {} },
			filters: [],
			...scope,
		})
	return { registry, captured, scoped, version }
}

/** Table names of the [name, ...] entries in an identity section. */
const named = (entries: unknown[][]) => entries.map(([name]) => String(name))

const throughB: [string, string][] = [['a', 'bs']]
const throughC: [string, string][] = [
	['a', 'bs'],
	['b', 'c'],
]

describe('scoped cursor identity', () => {
	test('covers exactly the given tables, edges and the tables those edges touch', () => {
		const base = world()
		for (const change of ['unrelated', 'incoming', 'brokenUnrelated', 'transitive'] as const)
			expect(world(change).scoped(['a'], throughB), change).toBe(base.scoped(['a'], throughB))
		for (const change of ['root', 'target', 'junction'] as const)
			expect(world(change).scoped(['a'], throughB), change).not.toBe(base.scoped(['a'], throughB))
		// A transitive edge counts once the query walks it.
		expect(world('transitive').scoped(['a'], throughC)).not.toBe(base.scoped(['a'], throughC))
		// A table alone ignores its edges, and a renamed edge is a different scope.
		expect(world('edge').scoped(['a'])).toBe(base.scoped(['a']))
		expect(() => world('edge').scoped(['a'], throughB)).toThrow('Unknown relation')
		// The full identity still covers everything.
		expect(world('unrelated').registry.identity).not.toBe(base.registry.identity)
		expect(world('incoming').registry.identity).not.toBe(base.registry.identity)
	})

	test('materializes only the scope, so a defect elsewhere stays deferred', () => {
		const { registry, captured, scoped } = world('brokenUnrelated')
		scoped(['a'])
		expect(captured).toEqual(['a'])
		scoped(['a'], throughB)
		expect([...new Set(captured)].sort()).toEqual(['a', 'b', 'links'])
		expect(() => registry.identity).toThrow(/opaque.*refine/i)
		expect(() => scoped(['missing'])).toThrow('Unknown query table')
		expect(() => scoped(['a'], [['a', 'missing']])).toThrow('Unknown relation')
	})

	test('uses the full identity encoding for each covered table and edge', () => {
		const { registry, scoped } = world()
		const [, tables, sources] = JSON.parse(registry.identity)
		const [version, scopedTables, scopedSources] = JSON.parse(scoped(['a'], throughC))
		expect(version).toBe(3)
		const reached = ['a', 'b', 'c', 'links']
		expect(named(scopedTables)).toEqual(reached)
		expect(scopedTables).toEqual(
			tables.filter(([name]: unknown[]) => reached.includes(String(name))),
		)
		expect(scopedSources).toEqual(
			sources.filter(([name]: unknown[]) => name === 'a' || name === 'b'),
		)
		// Unused edges of a covered source stay out.
		const [, , zSources] = JSON.parse(world('incoming').scoped(['z'], [['z', 'a']]))
		expect(zSources).toHaveLength(1)
		expect(named(zSources[0][1])).toEqual(['a'])
	})

	test('a query scope walks its path, selection, field groups and relation filters', async () => {
		const { scoped, version } = world()
		const expected = async (tables: string[], edges: [string, string][]) =>
			digest(scoped(tables, edges))
		expect(await version({})).toBe(await expected(['a'], []))
		expect(await version({ selection: { bs: { c: true } } })).toBe(await expected(['a'], throughC))
		expect(
			await version({ groups: { relations: { bs: { relations: { c: { relations: {} } } } } } }),
		).toBe(await expected(['a'], throughC))
		const nested = {
			kind: 'relation',
			name: 'bs',
			mode: 'some',
			predicate: {
				kind: 'not',
				child: { kind: 'relation', name: 'c', mode: 'one', predicate: null },
			},
		} as const
		expect(await version({ filters: [{ kind: 'and', children: [nested] }] })).toBe(
			await expected(['a'], throughC),
		)
		// A relation route binds its path and what it reads at the end of it.
		expect(await version({ path: ['bs'], selection: { c: true } })).toBe(
			await expected(['a'], throughC),
		)
		expect(await version({ path: ['bs'] })).toBe(await expected(['a', 'b'], throughB))
		expect(() => version({ selection: { missing: true } })).toThrow('INVALID_RELATION')
	})
})
