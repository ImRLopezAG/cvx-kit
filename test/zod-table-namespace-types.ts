import type { TableDefinition } from 'convex/server'
import { z } from 'zod'
import {
	createModule,
	namespace,
	namespaceIndex,
	tablesOf,
	tenantTable,
	zodTable,
} from '../src/zod-table'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

const items = tenantTable('items', () => ({ no: z.string() }))
const itemLedgerEntries = tenantTable('itemLedgerEntries', () => ({ qty: z.number() }))
const salesOrders = zodTable('salesOrders', () => ({ no: z.string() }))
const users = zodTable('users', () => ({ name: z.string() }))

const Inventory = namespace('Inventory', {
	items: items.table.index('by_no', ['tenant', 'no']),
	itemLedgerEntries,
})
const Sales = namespace('Microsoft.Sales', { salesOrders })
const plain = { users: users.table }

const tables = createModule(Inventory, Sales, plain)
export type FlatKeys = Assert<
	Equal<keyof typeof tables, 'items' | 'itemLedgerEntries' | 'salesOrders' | 'users'>
>
export type FlatValue = Assert<
	(typeof tables)['itemLedgerEntries'] extends TableDefinition<any> ? true : false
>

const names = namespaceIndex(Inventory, Sales)
const q = names.qualifiedName('itemLedgerEntries')
export type Qualified = Assert<Equal<typeof q, 'Inventory.ItemLedgerEntries'>>
const nested = names.qualifiedName('salesOrders')
export type NestedQualified = Assert<Equal<typeof nested, 'Microsoft.Sales.SalesOrders'>>
const ns = names.namespaceOf('items')
export type NamespaceOf = Assert<Equal<typeof ns, 'Inventory'>>
const inInventory = names.tablesOf('Inventory')
export type TablesOfName = Assert<
	Equal<(typeof inInventory)[number], 'items' | 'itemLedgerEntries'>
>
const listed = tablesOf(Inventory)
export type TablesOf = Assert<Equal<(typeof listed)[number], 'items' | 'itemLedgerEntries'>>

// @ts-expect-error a boundary must sit under its own table name
namespace('Inventory', { goods: items })
// @ts-expect-error users is not namespaced
names.qualifiedName('users')
// @ts-expect-error empty namespace segment
namespace('Microsoft..Inventory', { items })
