import { defineSchema } from 'convex/server'
import { z } from 'zod'
import { createModule, tenantTable, zodTable } from '../../src/zod-table'
import { webhookEventsTable } from '../../src/webhooks'

export const projects = tenantTable(
	'projects',
	() => ({
		name: z.string(),
		ownerId: z.string(),
	}),
	{
		commandFields: ['name'],
		publicFields: ['name'],
	},
)

// Deliberately NOT in the tenancy registry: default-deny must hide it.
export const globals = zodTable('globals', () => ({
	note: z.string(),
}))

// Audit sink for the CRUD factory tests (writable via an explicit RLS rule).
export const audits = zodTable('audits', () => ({
	operation: z.string(),
	actorId: z.string(),
	aggregateType: z.string(),
	aggregateId: z.string(),
}))

const projectTables = {
	projects: projects.table.index('by_tenant', ['tenant']),
}
const platformTables = {
	globals: globals.table,
	audits: audits.table,
	webhookEvents: webhookEventsTable().table.index('by_eventKey', [
		'eventKey',
	]),
}

export default defineSchema(createModule(projectTables, platformTables))
