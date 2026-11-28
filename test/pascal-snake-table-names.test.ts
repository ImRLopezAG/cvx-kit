import { defineTestApp } from 'convex-test'
import { defineSchema, type DataModelFromSchemaDefinition } from 'convex/server'
import { expect, test } from 'vite-plus/test'
import { k } from '../src/k'
import { createModule, tenantTable, kTable } from '../src/table'
import { defineRelations } from '../src/relations-public'
import { createQueryEngine } from '../src/querying'
import { createCursorCodec } from '../src/querying/cursors'
import { createTenantRules, wrapDatabaseReader, wrapDatabaseWriter } from '../src/tenancy'
import { createTriggers, tenantOwnership, timestamps } from '../src/triggers'
import { cursor, managed } from './fixture-querying/scalar'

function fixture() {
	const Inventory_Items = tenantTable(
		'Inventory_Items',
		{
			name: k.string(),
			status: k.string(),
		},
		{ publicFields: ['name', 'status'] },
	)
	Inventory_Items.table.index('by_status', ['status'])
	const Sales_PaymentJournals = kTable('Sales_PaymentJournals', {
		item: k.id('Inventory_Items'),
		amount: k.number(),
	})
	const schema = defineSchema(
		createModule(
			{ Inventory_Items: Inventory_Items.table },
			{ Sales_PaymentJournals: Sales_PaymentJournals.table },
		),
	)
	const relations = defineRelations({ Inventory_Items, Sales_PaymentJournals }, (r) => ({
		Sales_PaymentJournals: {
			inventory: r.one.Inventory_Items({
				from: r.Sales_PaymentJournals.item,
				to: r.Inventory_Items._id,
			}),
		},
	}))
	const { createTest } = defineTestApp({ schema }).defineModules({})
	return {
		Inventory_Items,
		Sales_PaymentJournals,
		schema,
		relations,
		t: createTest(),
		querying: createQueryEngine({ schema, relations, cursor }),
	}
}
type DM = DataModelFromSchemaDefinition<ReturnType<typeof fixture>['schema']>

test('schema composition and zid retain uppercase and underscore table names', async () => {
	const f = fixture()
	expect(Object.keys(f.schema.tables)).toEqual(['Inventory_Items', 'Sales_PaymentJournals'])
	expect(f.Inventory_Items.tableName).toBe('Inventory_Items')
	expect(f.Sales_PaymentJournals.tableName).toBe('Sales_PaymentJournals')
	expect(k.id('Inventory_Items').validator.tableName).toBe('Inventory_Items')
	expect(f.Inventory_Items.insertSchema.shape).not.toHaveProperty('tenant')
	await f.t.run(async ({ db }) => {
		const item = await db.insert('Inventory_Items', { name: 'A', status: 'open', tenant: 'one' })
		expect(f.Sales_PaymentJournals.insertSchema.parse({ item, amount: 12 })).toEqual({
			item,
			amount: 12,
		})
		const payment = await db.insert('Sales_PaymentJournals', { item, amount: 12 })
		expect((await db.get(payment))?.item).toBe(item)
	})
})

test('filtered indexed pages and materialized relations preserve table names', async () => {
	const f = fixture()
	await f.t.run(async ({ db }) => {
		const ids = []
		for (const name of ['A', 'B', 'C']) {
			ids.push(await db.insert('Inventory_Items', { name, status: 'open', tenant: 'one' }))
		}
		await db.insert('Inventory_Items', { name: 'closed', status: 'closed', tenant: 'one' })
		await db.insert('Sales_PaymentJournals', { item: ids[1]!, amount: 12 })
		const q = f.querying(managed<DM>(db))
		const first = await q.Inventory_Items.paginate({
			numItems: 1,
			cursor: null,
			filters: { status: 'open' },
		})
		expect(first.page.map((row) => row.name)).toEqual(['A'])
		expect(first.isDone).toBe(false)
		const next = await q.Inventory_Items.paginate({
			numItems: 10,
			cursor: first.continueCursor,
			filters: { status: 'open' },
		})
		expect(next.page.map((row) => row.name)).toEqual(['B', 'C'])
		expect(next.isDone).toBe(true)
		await expect(
			q.Sales_PaymentJournals.paginate({ numItems: 1, cursor: first.continueCursor }),
		).rejects.toThrow('Invalid cursor')
		const payments = await q.Sales_PaymentJournals.with({ inventory: true }).paginate({
			numItems: 10,
			cursor: null,
		})
		expect(payments.page[0]?.inventory).toEqual({ _id: ids[1], name: 'B', status: 'open' })
		expect(
			f.relations.tables.Sales_PaymentJournals.pageDto({ inventory: true }).parse(payments),
		).toEqual(payments)
	})
})

test('cursor codec binds the exact case-sensitive table name', () => {
	const codec = createCursorCodec(cursor)
	const binding = {
		table: 'Inventory_Items',
		order: 'asc' as const,
		clientFilters: {},
		serverFilters: {},
		relationPath: [],
		principal: 'user',
		tenant: 'one',
		policyVersion: '1',
		engineVersion: '1',
		registryVersion: '1',
	}
	const token = codec.seal('native continuation', binding)
	expect(codec.open(token, binding)).toBe('native continuation')
	for (const table of [
		'inventory_Items',
		'Inventory_items',
		'InventoryItems',
		'Sales_PaymentJournals',
	]) {
		expect(() => codec.open(token, { ...binding, table })).toThrow('Invalid cursor')
	}
})

test('tenant rules scope native and managed readers and reject foreign writes', async () => {
	const f = fixture()
	await f.t.run(async ({ db }) => {
		const own = await db.insert('Inventory_Items', { name: 'own', status: 'open', tenant: 'one' })
		const foreign = await db.insert('Inventory_Items', {
			name: 'foreign',
			status: 'open',
			tenant: 'two',
		})
		const rules = createTenantRules<DM>('one', ['Inventory_Items'])
		expect(Object.keys(rules)).toEqual(['Inventory_Items'])
		const reader = wrapDatabaseReader({}, db, rules, { defaultPolicy: 'deny' })
		expect((await reader.query('Inventory_Items').collect()).map((row) => row._id)).toEqual([own])
		expect(await reader.get(foreign)).toBeNull()
		const page = await f
			.querying(managed<DM>(db, rules, 'deny'))
			.Inventory_Items.paginate({ numItems: 10, cursor: null })
		expect(page.page.map((row) => row._id)).toEqual([own])
		const writer = wrapDatabaseWriter({}, db, rules, { defaultPolicy: 'deny' })
		await expect(
			writer.insert('Inventory_Items', { name: 'bad', status: 'open', tenant: 'two' }),
		).rejects.toThrow()
		await expect(writer.patch(foreign, { name: 'bad' })).rejects.toThrow()
	})
})

test('timestamp and tenant ownership triggers dispatch by the exact table name', async () => {
	const f = fixture()
	const triggers = createTriggers<DM>()
	timestamps(triggers, 'Inventory_Items')
	tenantOwnership(triggers, 'Inventory_Items')
	const id = await f.t.run(async (ctx) => {
		const db = triggers.wrapDB(ctx).db
		return db.insert('Inventory_Items', { name: 'A', status: 'open', tenant: 'one' })
	})
	const row = await f.t.run(({ db }) => db.get(id))
	expect(row).toMatchObject({
		tenant: 'one',
		createdAt: expect.any(Number),
		updatedAt: expect.any(Number),
	})
	await expect(
		f.t.run((ctx) => triggers.wrapDB(ctx).db.patch(id, { tenant: 'two' })),
	).rejects.toThrow('Inventory_Items tenant ownership cannot be reassigned')
	await expect(
		f.t.run((ctx) =>
			triggers
				.wrapDB(ctx)
				.db.insert('Inventory_Items', { name: 'bad', status: 'open', tenant: '' }),
		),
	).rejects.toThrow('Inventory_Items rows require a tenant')
	expect((await f.t.run(({ db }) => db.get(id)))?.tenant).toBe('one')
})
