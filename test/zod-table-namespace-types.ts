import type { TableDefinition } from 'convex/server'
import { z } from 'zod'
import {
	createModule,
	namespace,
	namespaceIndex,
	namespaceName,
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

const label = namespaceName(Inventory)
export type NamespaceLabel = Assert<Equal<typeof label, 'Inventory'>>
declare const either: 'items' | 'salesOrders'
const unionQualified = names.qualifiedName(either)
export type UnionQualified = Assert<
	Equal<typeof unionQualified, 'Inventory.Items' | 'Microsoft.Sales.SalesOrders'>
>
// @ts-expect-error untagged maps are not namespaces
namespaceName({})
// @ts-expect-error untagged maps are not namespaces
namespaceIndex({ users: users.table })
// @ts-expect-error unknown namespace name
names.tablesOf('Purchase')

const invItems = tenantTable('Inventory_Items', () => ({ no: z.string() }))
const PrefixedInventory = namespace(
	'Inventory',
	{
		Inventory_Items: invItems.table.index('by_no', ['tenant', 'no']),
		Inventory_ItemLedgerEntries: tenantTable('Inventory_ItemLedgerEntries', () => ({})),
	},
	{ prefixed: true },
)
const Fin = namespace('Microsoft.Finance', {
	Microsoft_Finance_GLEntries: users.table,
	legacyAccounts: users.table,
})
const prefixedNames = namespaceIndex(PrefixedInventory, Fin)
const stripped = prefixedNames.qualifiedName('Inventory_Items')
export type Stripped = Assert<Equal<typeof stripped, 'Inventory.Items'>>
const dotted = prefixedNames.qualifiedName('Microsoft_Finance_GLEntries')
export type DottedStripped = Assert<Equal<typeof dotted, 'Microsoft.Finance.GLEntries'>>
const mixed = prefixedNames.qualifiedName('legacyAccounts')
export type Mixed = Assert<Equal<typeof mixed, 'Microsoft.Finance.LegacyAccounts'>>
export type PrefixedKeys = Assert<
	Equal<keyof typeof PrefixedInventory & string, 'Inventory_Items' | 'Inventory_ItemLedgerEntries'>
>
// @ts-expect-error strict namespaces require the prefix on every key
namespace('Inventory', { items: items.table }, { prefixed: true })
// @ts-expect-error a bare prefix is not a member name
namespace('Inventory', { Inventory_: users.table }, { prefixed: true })

const salesNs = namespace(
	'sales',
	{ sales_header: users.table, sales_cust_ledger_entry: users.table },
	{ prefixed: true },
)
const msNs = namespace('microsoft.inventory', { microsoft_inventory_item: users.table })
const snake = namespaceIndex(salesNs, msNs)
const header = snake.qualifiedName('sales_header')
export type SnakeHeader = Assert<Equal<typeof header, 'sales.header'>>
const cle = snake.qualifiedName('sales_cust_ledger_entry')
export type SnakeLedger = Assert<Equal<typeof cle, 'sales.cust_ledger_entry'>>
const msItem = snake.qualifiedName('microsoft_inventory_item')
export type SnakeDotted = Assert<Equal<typeof msItem, 'microsoft.inventory.item'>>
// @ts-expect-error prefix matching is case-sensitive
namespace('sales', { Sales_header: users.table }, { prefixed: true })
