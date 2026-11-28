import { defineTable } from 'convex/server'
import { describe, expect, it } from 'vitest'
import { k } from '../src/k'
import { defineRelations } from '../src/relations'
import { kTable, kVariantTable } from '../src/table'

const lazyMembers = [
	'table',
	'storage',
	'schema',
	'insertSchema',
	'updateSchema',
	'commandInput',
	'publicDto',
	'tools',
] as const

describe('object spread of a table boundary', () => {
	it('keeps every lazy member of a kTable boundary', () => {
		const tasks = kTable('tasks', { title: k.string() }, { publicFields: ['title'] })
		const copy = { ...tasks }
		for (const member of lazyMembers) expect(member in copy, member).toBe(true)
		expect(copy.schema).toBe(tasks.schema)
		expect(copy.publicDto).toBe(tasks.publicDto)
		expect(copy.insert()).toBe(tasks.insert())
		expect(copy.toPublicDto({ title: 'x' })).toEqual({ title: 'x' })
	})

	it('keeps every lazy member of a variant boundary and of a legacy variant table', () => {
		const storage = k.discriminatedUnion('kind', [
			k.object({ kind: k.literal('a'), x: k.number() }),
			k.object({ kind: k.literal('b'), y: k.string() }),
		])
		const variants = kVariantTable('items', storage, {
			discriminator: 'kind',
			variants: { a: { publicFields: ['x'] }, b: {} },
		})
		const copy = { ...variants }
		for (const member of lazyMembers) expect(member in copy, member).toBe(true)
		expect(copy.schema).toBe(variants.schema)
		expect(copy.dto()).toBe(variants.dto())
		const legacy = kVariantTable('legacy', storage)
		expect({ ...legacy }.table).toBe(legacy.table)
	})

	it('reads nothing until a member is first used', () => {
		const tasks = kTable('lazyTasks', { title: k.string() })
		const descriptor = Object.getOwnPropertyDescriptor(tasks, 'schema')
		expect(descriptor?.get).toBeTypeOf('function')
		expect(descriptor?.enumerable).toBe(true)
	})

	it('lets a spread copy replace `table` and still serve defineRelations', () => {
		const tasks = kTable('tasks', { title: k.string(), parent: k.id('tasks').nullable() })
		const indexed = {
			...tasks,
			table: defineTable(tasks.storage.validator).index('by_parent', ['parent']),
		}
		const relations = defineRelations({ tasks: indexed }, (r) => ({
			tasks: { parentTask: r.one.tasks({ from: r.tasks.parent, to: r.tasks._id }) },
		}))
		expect(relations.tables.tasks).toBeDefined()
	})
})
