import { expect, test } from 'vite-plus/test'
import { defineRelations } from '../src/relations'
import { createQueryEngine } from '../src/querying'
import { zodTable, zodVariantTable, zodToConvex } from '../src/zod-table'
import { z } from 'zod'
import {
	defineSchema,
	anyApi,
	queryGeneric,
	type DataModelFromSchemaDefinition,
} from 'convex/server'
import {
	groupDeclarations,
	fieldGroupFixture,
	seedFieldGroups,
} from './fixture-querying/field-groups'
import { cursor, managed, observed } from './fixture-querying/scalar'
import { convexTest } from 'convex-test'
import { ConvexError } from 'convex/values'

test('group registration rejects unknown, duplicate, public and overlapping fields', () => {
	const f = groupDeclarations()
	const invalid: Record<string, string[]>[] = [
		{ finance: ['unknown'] },
		{ finance: ['balance', 'balance'] },
		{ finance: ['name'] },
		{ finance: ['balance'], other: ['balance'] },
	]
	for (const fieldGroups of invalid)
		expect(() => defineRelations({ clients: { ...f.clients, fieldGroups } }, () => ({}))).toThrow(
			/field groups/,
		)
})

test('variant groups reject conflicting stored containers instead of guessing a schema', () => {
	const records = zodVariantTable(
		'records',
		z.discriminatedUnion('kind', [
			z.strictObject({ kind: z.literal('one'), value: z.object({ amount: z.number() }) }),
			z.strictObject({ kind: z.literal('two'), value: z.array(z.number()) }),
		]),
		{ discriminator: 'kind', variants: { one: { publicFields: [] }, two: { publicFields: [] } } },
	)
	expect(() =>
		defineRelations({ records: { ...records, fieldGroups: { private: ['value'] } } }, () => ({})),
	).toThrow(/incompatible field groups/)
})

test('captured membership, stored schema, policies and materialized validators resist caller mutation', async () => {
	const f = fieldGroupFixture()
	await seedFieldGroups(f)
	const validator = f.relations.tables.clients.pageDto({}, { fieldGroups: { finance: 'required' } })
	Reflect.set(f.definitions.clients.fieldGroups.finance, 0, 'secret')
	Reflect.set(f.clients.schema.shape, 'balance', z.string())
	f.policies.clients.finance = async () => false
	// Mutating a caller-owned validator cannot alter an engine's captured projection.
	Reflect.set(validator, '_zod', { def: {} })
	const result = await f.t
		.withIdentity({ subject: 'user', org_id: 'one', role: 'reader' })
		.query(anyApi.functions.page, { cursor: null, numItems: 1 })
	expect(result.page[0].balance).toBe(42n)
	expect(result.page[0]).not.toHaveProperty('secret')
})

test('protected predicates and ordering reject before native query construction even for empty or contradictory input', async () => {
	const f = groupDeclarations()
	const t = fieldGroupFixture().t
	const engine = createQueryEngine(f, {
		cursor,
		fieldGroups: { clients: { finance: () => false } },
	})
	await t.run(async ({ db }) => {
		const o = observed(db)
		const query = engine(managed(o.raw)).clients.include({ finance: 'if-permitted' })
		for (const filters of [
			{ not: { balance: 1n } },
			{ and: [{ balance: { gt: 2n } }, { balance: { lt: 1n } }] },
		])
			await expect(query.paginate({ cursor: null, numItems: 1, filters })).rejects.toThrow(
				'FIELD_GROUP_DENIED',
			)
		await expect(
			query.orderBy('by_balance').paginate({ cursor: null, numItems: 1 }),
		).rejects.toThrow('FIELD_GROUP_DENIED')
		expect(o.counts).toEqual({ next: 0, returned: 0, ranges: 0, gets: 0, closes: 0 })
	})
})

test('group extension never runs private stored transforms or exposes unrelated private DTO fields', async () => {
	let calls = 0
	const records = zodTable(
		'records',
		() => ({
			name: z.string(),
			value: z.number().transform((n) => {
				calls++
				return String(n + 1)
			}),
			secret: z.string(),
		}),
		{ publicFields: ['name'] },
	)
	const relations = defineRelations(
		{ records: { ...records, fieldGroups: { private: ['value'] } } },
		() => ({}),
	)
	const schema = defineSchema({ records: records.table })
	const engine = createQueryEngine(
		{ schema, relations },
		{ cursor, fieldGroups: { records: { private: () => true } } },
	)
	expect(calls).toBe(0)
	const t = convexTest(schema, { './_generated/server.ts': async () => ({}) })
	await t.run(async ({ db }) => {
		// @ts-expect-error existing table types infer parser output; the captured native validator stores number
		await db.insert('records', { name: 'test', value: 2, secret: 'never-public' })
		const result = await engine(managed<DataModelFromSchemaDefinition<typeof schema>>(db))
			.records.include({ private: 'required' })
			.paginate({ cursor: null, numItems: 1 })
		const native: number = result.page[0].value
		void native
		expect(result.page[0].value).toBe(2)
		expect(result.page[0]).not.toHaveProperty('secret')
		expect(
			relations.tables.records
				.pageDto({}, { fieldGroups: { private: 'required' } })
				.safeParse(result).success,
		).toBe(true)
		expect(calls).toBe(0)
	})
})

test('registration rejects inherited group data and accessors without invoking getters', () => {
	const f = groupDeclarations()
	let calls = 0
	for (const prototype of [
		{ fieldGroups: { finance: ['balance'] } },
		Object.defineProperty({}, 'fieldGroups', {
			get: () => {
				calls++
				return {}
			},
		}),
	]) {
		const inherited = Object.assign(Object.create(prototype), f.clients)
		expect(() => defineRelations({ clients: inherited }, () => ({}))).toThrow(/field groups/)
	}
	expect(calls).toBe(0)
})

function sortingGroups() {
	const parents = zodTable('parents', () => ({ name: z.string() }))
	const children = zodTable(
		'children',
		(id) => ({
			parent: id('parents'),
			key: z.string(),
			name: z.string(),
			profile: z.object({ cents: z.number() }),
		}),
		{ publicFields: ['name'] },
	)
	const links = zodTable(
		'links',
		(id) => ({ parent: id('parents'), child: id('children'), key: z.string(), rank: z.number() }),
		{ publicFields: [] },
	)
	const grandchildren = zodTable(
		'grandchildren',
		(id) => ({ child: id('children'), name: z.string(), secret: z.string() }),
		{ publicFields: ['name'] },
	)
	const schema = defineSchema({
		grandchildren: grandchildren.table.index('by_child', ['child']),
		parents: parents.table,
		children: children.table
			.index('by_profile', ['profile.cents'])
			.index('by_key_profile', ['key', 'profile.cents'])
			.index('by_parent_profile', ['parent', 'profile.cents']),
		links: links.table.index('by_parent_rank', ['parent', 'rank']),
	})
	const relations = defineRelations(
		{
			parents,
			grandchildren: { ...grandchildren, fieldGroups: { private: ['secret'] as const } },
			children: { ...children, fieldGroups: { private: ['profile'] as const } },
			links: { ...links, fieldGroups: { private: ['rank'] as const } },
		},
		(r) => ({
			children: {
				grandchildren: r.many.grandchildren({ from: r.children._id, to: r.grandchildren.child }),
			},
			parents: {
				direct: r.many.children({ from: r.parents._id, to: r.children.parent }),
				ids: r.many.children({
					from: r.parents._id.through(r.links.parent),
					to: r.children._id.through(r.links.child),
				}),
				keys: r.many.children({
					from: r.parents._id.through(r.links.parent),
					to: r.children.key.through(r.links.key),
				}),
			},
		}),
	)
	const permission = { allowed: true, childVisible: true, ancestorAllowed: true }
	const querying = createQueryEngine(
		{ schema, relations },
		{
			cursor,
			fieldGroups: {
				children: { private: () => permission.ancestorAllowed },
				grandchildren: { private: () => permission.allowed },
			},
		},
	)
	const reads: ReturnType<typeof observed>['counts'][] = []
	function context(
		db: import('convex/server').GenericDatabaseReader<DataModelFromSchemaDefinition<typeof schema>>,
	) {
		const o = observed(db)
		reads.push(o.counts)
		return managed(o.raw, { children: { read: async () => permission.childVisible } })
	}
	const page = queryGeneric({
		args: zodToConvex(relations.tables.parents.paginationOpts({})),
		handler: (ctx, args) =>
			querying(context(ctx.db))
				.parents.with(
					{ direct: { grandchildren: true } },
					{
						relations: {
							direct: {
								fieldGroups: { private: 'required' },
								relations: { grandchildren: { fieldGroups: { private: 'required' } } },
							},
						},
					},
				)
				.paginate(args),
	})
	const next = queryGeneric({
		args: zodToConvex(
			relations.tables.grandchildren
				.paginationOpts({})
				.extend({ parent: parents.schema.shape._id }),
		),
		handler: (ctx, { parent, ...args }) =>
			querying(context(ctx.db))
				.parents.relation(parent, 'direct.grandchildren')
				.include({ private: 'required' })
				.paginate(args),
	})
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ page, next }),
	})
	return { t, querying, reads, permission }
}

test('dotted protected index paths deny explicit and automatic root sorting before reads', async () => {
	const f = sortingGroups()
	await f.t.run(async ({ db }) => {
		const o = observed(db)
		const query = f.querying(managed(o.raw)).children
		await expect(
			query.orderBy('by_profile').paginate({ cursor: null, numItems: 1 }),
		).rejects.toThrow('FIELD_GROUP_DENIED')
		await expect(query.where({ key: 'a' }).paginate({ cursor: null, numItems: 1 })).rejects.toThrow(
			'FIELD_GROUP_DENIED',
		)
		expect(o.counts.next + o.counts.gets + o.counts.ranges).toBe(0)
	})
})

test('selected direct sorting is admitted before empty, contradictory and populated parent traversal', async () => {
	const f = sortingGroups()
	await f.t.run(async ({ db }) => {
		const o = observed(db)
		const query = f.querying(managed(o.raw)).parents.with({ direct: true })
		for (const filters of [undefined, { and: [{ name: 'a' }, { name: 'b' }] }])
			await expect(query.paginate({ cursor: null, numItems: 1, filters })).rejects.toThrow(
				'FIELD_GROUP_DENIED',
			)
		const parent = await db.insert('parents', { name: 'a' })
		await expect(
			f
				.querying(managed(o.raw))
				.parents.relation(parent, 'direct')
				.orderBy('by_parent_profile')
				.paginate({ cursor: null, numItems: 1 }),
		).rejects.toThrow('FIELD_GROUP_DENIED')
		await expect(query.paginate({ cursor: null, numItems: 1 })).rejects.toThrow(
			'FIELD_GROUP_DENIED',
		)
		expect(o.counts.next + o.counts.gets + o.counts.ranges).toBe(0)
	})
})

test('junction sorting cannot borrow a target group grant for ID or indexed targets', async () => {
	const f = sortingGroups()
	await f.t.run(async ({ db }) => {
		const parent = await db.insert('parents', { name: 'a' })
		const o = observed(db)
		const query = f.querying(managed(o.raw)).parents
		await expect(
			query
				.with({ ids: true }, { relations: { ids: { fieldGroups: { private: 'required' } } } })
				.paginate({ cursor: null, numItems: 1 }),
		).rejects.toThrow('FIELD_GROUP_DENIED')
		await expect(
			query
				.with({ keys: true }, { relations: { keys: { fieldGroups: { private: 'required' } } } })
				.paginate({ cursor: null, numItems: 1 }),
		).rejects.toThrow('FIELD_GROUP_DENIED')
		for (const name of ['ids', 'keys'] as const) {
			await expect(
				query
					.relation(parent, name)
					.include({ private: 'required' })
					.paginate({ cursor: null, numItems: 1 }),
			).rejects.toThrow('FIELD_GROUP_DENIED')
		}
		expect(o.counts.next + o.counts.gets + o.counts.ranges).toBe(0)
	})
})

test('private policy errors are redacted and cached denial still enforces required requests', async () => {
	const f = groupDeclarations()
	const t = fieldGroupFixture().t
	await t.run(async ({ db }) => {
		for (const cause of [
			new Error('private-policy-value'),
			new ConvexError({ secret: 'private-policy-value' }),
		]) {
			const querying = createQueryEngine(f, {
				cursor,
				fieldGroups: {
					clients: {
						finance: () => {
							throw cause
						},
					},
				},
			})
			await expect(
				querying(managed(db))
					.clients.include({ finance: 'required' })
					.paginate({ cursor: null, numItems: 1 }),
			).rejects.toMatchObject({
				name: 'FieldGroupError',
				code: 'FIELD_GROUP_DENIED',
				message: 'FIELD_GROUP_DENIED',
			})
		}
		let calls = 0
		const querying = createQueryEngine(f, {
			cursor,
			fieldGroups: {
				clients: {
					finance: () => {
						calls++
						return false
					},
				},
			},
		})
		const query = querying(managed(db)).clients
		await query.include({ finance: 'if-permitted' }).paginate({ cursor: null, numItems: 1 })
		await expect(
			query.include({ finance: 'required' }).paginate({ cursor: null, numItems: 1 }),
		).rejects.toThrow('FIELD_GROUP_DENIED')
		expect(calls).toBe(1)
	})
})

test('registered two-hop cursors resume without sorting protected ancestors and retain current authorization', async () => {
	const f = sortingGroups()
	const parent = await f.t.run(async ({ db }) => {
		const parent = await db.insert('parents', { name: 'p' })
		const child = await db.insert('children', {
			parent,
			key: 'a',
			name: 'c',
			profile: { cents: 10 },
		})
		for (const name of ['a', 'b', 'c'])
			await db.insert('grandchildren', { child, name, secret: 'allowed' })
		return parent
	})
	const first = await f.t.query(anyApi.functions.page, { cursor: null, numItems: 1 })
	const token = first.page[0].direct.page[0].grandchildren.continueCursor
	// Ancestor fields are neither projected nor sorted on continuation; current row access is still required.
	f.permission.ancestorAllowed = false
	const resumed = await f.t.query(anyApi.functions.next, { parent, cursor: token, numItems: 1 })
	expect(resumed.page.map((row: { name: string }) => row.name)).toEqual(['b'])
	const bounded = await f.t.query(anyApi.functions.next, {
		parent,
		cursor: null,
		endCursor: token,
		numItems: 1,
	})
	expect(bounded.page.map((row: { name: string }) => row.name)).toEqual(['a'])
	f.permission.allowed = false
	for (const slots of [{ cursor: token }, { endCursor: token }]) {
		await expect(
			f.t.query(anyApi.functions.next, { parent, cursor: null, numItems: 1, ...slots }),
		).rejects.toThrow('FIELD_GROUP_DENIED')
		expect(f.reads.at(-1)).toEqual({ next: 0, returned: 0, ranges: 0, gets: 0, closes: 0 })
	}
	f.permission.allowed = true
	f.permission.childVisible = false
	const hidden = await f.t.query(anyApi.functions.next, { parent, cursor: token, numItems: 1 })
	expect(hidden.page).toEqual([])
	f.permission.childVisible = true
	await f.t.run(async ({ db }) => {
		const other = await db.insert('parents', { name: 'other' })
		await db.patch('children', first.page[0].direct.page[0]._id, { parent: other })
	})
	const detached = await f.t.query(anyApi.functions.next, { parent, cursor: token, numItems: 1 })
	expect(detached.page).toEqual([])
})
