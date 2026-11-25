import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
	createModule,
	memberName,
	namespace,
	namespaceIndex,
	namespaceName,
	tablesOf,
	zodTable,
} from '../src/zod-table'

const items = zodTable('items', () => ({ no: z.string() }))
const itemLedgerEntries = zodTable('itemLedgerEntries', () => ({ qty: z.number() }))
const salesOrders = zodTable('salesOrders', () => ({ no: z.string() }))
const users = zodTable('users', () => ({ name: z.string() }))

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
		expect(() => namespace('inventory', { items })).toThrow(/PascalCase/)
		expect(() => namespace('Inventory', { Items: items.table })).toThrow(/camelCase/)
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
})
