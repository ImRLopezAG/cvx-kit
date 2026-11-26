import { describe, expect, it } from 'vitest'
import { k } from '../src/k'
import {
	createModule,
	memberName,
	namespace,
	namespaceIndex,
	namespaceName,
	namespacePrefix,
	tablesOf,
	kTable,
} from '../src/table'

const items = kTable('items', { no: k.string() })
const itemLedgerEntries = kTable('itemLedgerEntries', { qty: k.number() })
const salesOrders = kTable('salesOrders', { no: k.string() })
const users = kTable('users', { name: k.string() })

describe('namespace', () => {
	const Inventory = namespace('Inventory', {
		items: items.table,
		itemLedgerEntries,
	})
	const Sales = namespace('Microsoft.Sales', { salesOrders: salesOrders.table })

	it('flattens to the plain table map alongside un-namespaced maps', () => {
		const tables = createModule(Inventory, Sales, { users: users.table })
		expect(tables).toEqual({
			items: items.table,
			itemLedgerEntries: itemLedgerEntries.table,
			salesOrders: salesOrders.table,
			users: users.table,
		})
		expect(Object.keys(Inventory)).toEqual(['items', 'itemLedgerEntries'])
		expect(Object.getOwnPropertySymbols(tables)).toEqual([])
	})

	it('exposes qualified names and membership', () => {
		const names = namespaceIndex(Inventory, Sales)
		expect(names.qualifiedName('itemLedgerEntries')).toBe('Inventory.ItemLedgerEntries')
		expect(names.qualifiedName('salesOrders')).toBe('Microsoft.Sales.SalesOrders')
		expect(names.namespaceOf('items')).toBe('Inventory')
		expect(names.tablesOf('Inventory')).toEqual(['items', 'itemLedgerEntries'])
		expect(names.namespaces).toEqual(['Inventory', 'Microsoft.Sales'])
		expect(names.has('users')).toBe(false)
		expect(tablesOf(Inventory)).toEqual(['items', 'itemLedgerEntries'])
		expect(namespaceName(Sales)).toBe('Microsoft.Sales')
		expect(memberName('items')).toBe('Items')
	})

	it('rejects a boundary under another table key and bad names', () => {
		// @ts-expect-error key mismatch is also a type error
		expect(() => namespace('Inventory', { goods: items })).toThrow(/holds table "items"/)
		expect(() => namespace('1nventory', { items })).toThrow(/identifiers/)
		expect(() => namespace('sales_x', { items })).toThrow(/identifiers/)
		expect(() => namespace('Inventory', { 'bad-name': items.table })).toThrow(/table name/)
	})

	it('rejects duplicate tables and namespaces', () => {
		const Other = namespace('Other', { items: items.table })
		const Again = namespace('Inventory', { users: users.table })
		expect(() => createModule(Inventory, Other)).toThrow(/more than one module/)
		expect(() => namespaceIndex(Inventory, Other)).toThrow(/namespaces "Inventory" and "Other"/)
		expect(() => createModule(Inventory, Again)).toThrow(
			/Namespace "Inventory" is declared more than once/,
		)
		expect(() => namespaceIndex(Inventory, Again)).toThrow(/declared more than once/)
	})

	it('strips the namespace prefix from stored table names', () => {
		const stored = kTable('Inventory_Items', { no: k.string() })
		const Inv = namespace('Inventory', { Inventory_Items: stored, legacyBins: users.table })
		const Fin = namespace('Microsoft.Finance', { Microsoft_Finance_GLEntries: users.table })
		const names = namespaceIndex(Inv, Fin)
		expect(names.qualifiedName('Inventory_Items')).toBe('Inventory.Items')
		expect(names.qualifiedName('legacyBins')).toBe('Inventory.LegacyBins')
		expect(names.qualifiedName('Microsoft_Finance_GLEntries')).toBe('Microsoft.Finance.GLEntries')
		expect(namespacePrefix('Microsoft.Finance')).toBe('Microsoft_Finance_')
		expect(memberName('Inventory_', 'Inventory')).toBe('Inventory_')
		expect(createModule(Inv)).toEqual({ Inventory_Items: stored.table, legacyBins: users.table })
	})

	it('enforces prefixes in strict mode', () => {
		expect(
			namespace('Inventory', { Inventory_Items: items.table }, { prefixed: true }),
		).toHaveProperty('Inventory_Items')
		// @ts-expect-error missing prefix is also a type error
		expect(() => namespace('Inventory', { items: items.table }, { prefixed: true })).toThrow(
			/must start with "Inventory_"/,
		)
		expect(() => namespace('Inventory', { _items: items.table })).toThrow(/table name/)
	})

	it('accepts lowercase snake_case namespaces and stored names', () => {
		const sales = namespace(
			'sales',
			{ sales_header: users.table, sales_cust_ledger_entry: users.table },
			{ prefixed: true },
		)
		const ms = namespace('microsoft.inventory', { microsoft_inventory_item: users.table })
		const names = namespaceIndex(sales, ms)
		expect(names.qualifiedName('sales_header')).toBe('sales.header')
		expect(names.qualifiedName('sales_cust_ledger_entry')).toBe('sales.cust_ledger_entry')
		expect(names.qualifiedName('microsoft_inventory_item')).toBe('microsoft.inventory.item')
		expect(namespacePrefix('microsoft.inventory')).toBe('microsoft_inventory_')
		expect(memberName('sales_header', 'sales')).toBe('header')
		// @ts-expect-error prefix matching is case-sensitive
		expect(() => namespace('sales', { Sales_header: users.table }, { prefixed: true })).toThrow(
			/must start with "sales_"/,
		)
	})
})
