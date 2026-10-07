import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { tenantTable } from 'cvx-kit/zod-table'
import { z } from 'zod'

const noteFields = () => ({ title: z.string(), secret: z.string(), owner: z.string() })

export const crudNotes = tenantTable<
	'crudNotes',
	ReturnType<typeof noteFields>,
	readonly ['secret', 'owner'],
	readonly ['title'],
	readonly ['title']
>('crudNotes', noteFields, {
	commandFields: ['title'],
	serverFields: ['secret', 'owner'],
	publicFields: ['title'],
})

export default defineSchema({
	writes: defineTable({ key: v.string(), stage: v.string() }).index('by_key', ['key']),
	crudNotes: crudNotes.table.index('by_tenant', ['tenant']),
	crudOthers: defineTable({
		title: v.string(),
		secret: v.string(),
		owner: v.string(),
		tenant: v.string(),
		archivedAt: v.optional(v.number()),
	}).index('by_tenant', ['tenant']),
	crudHistory: defineTable({ id: v.id('crudNotes'), operation: v.string() }).index('by_note', [
		'id',
	]),
	crudAudits: defineTable({ operation: v.string(), actor: v.string(), id: v.string() }).index(
		'by_note',
		['id'],
	),
})
