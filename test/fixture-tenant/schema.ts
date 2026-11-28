import { defineSchema } from 'convex/server'
import { k } from '../../src/k'
import { createModule, kTable, tenantTable } from '../../src/table'
import { webhookEventsTable } from '../../src/webhooks'

export const projects = tenantTable(
	'projects',
	{
		name: k.string(),
		ownerId: k.string(),
	},
	{
		commandFields: ['name'],
		publicFields: ['name'],
	},
)

// Deliberately NOT in the tenancy registry: default-deny must hide it.
export const globals = kTable('globals', {
	note: k.string(),
})

// Audit sink for the CRUD factory tests (writable via an explicit RLS rule).
export const audits = kTable('audits', {
	operation: k.string(),
	actorId: k.string(),
	aggregateType: k.string(),
	aggregateId: k.string(),
})

const projectTables = {
	projects: projects.table.index('by_tenant', ['tenant']),
}
const platformTables = {
	globals: globals.table,
	audits: audits.table,
	webhookEvents: webhookEventsTable().table.index('by_eventKey', ['eventKey']),
}

export default defineSchema(createModule(projectTables, platformTables))
