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

const idempotentFields = () => ({ title: z.string(), key: z.string(), scope: z.string() })
export const idempotentNotes = tenantTable<
	'idempotentNotes',
	ReturnType<typeof idempotentFields>,
	readonly ['key', 'scope'],
	readonly ['title'],
	readonly ['title']
>('idempotentNotes', idempotentFields, {
	commandFields: ['title'],
	serverFields: ['key', 'scope'],
	publicFields: ['title'],
})

export const receiptVersions = v.object({
	operation: v.string(),
	contract: v.string(),
	binding: v.string(),
	fingerprintPolicy: v.string(),
})

export default defineSchema({
	idempotentNotes: idempotentNotes.table.index('by_scope_key', ['scope', 'key']),
	idempotentAudits: defineTable({
		tenant: v.string(),
		scope: v.string(),
		key: v.string(),
		id: v.id('idempotentNotes'),
		operation: v.string(),
	}).index('by_scope_key', ['scope', 'key']),
	idempotentReceipts: defineTable({
		tenant: v.string(),
		operation: v.string(),
		scope: v.string(),
		key: v.string(),
		versions: receiptVersions,
		fingerprint: v.string(),
		state: v.union(v.literal('pending'), v.literal('completed')),
		result: v.optional(v.any()),
	}).index('by_identity', ['operation', 'scope', 'key']),
	idempotentPermissions: defineTable({ scope: v.string(), allowed: v.boolean() }).index(
		'by_scope',
		['scope'],
	),
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
