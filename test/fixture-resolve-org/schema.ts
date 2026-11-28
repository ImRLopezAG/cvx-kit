import { defineSchema } from 'convex/server'
import { k } from '../../src/k'
import { createModule, kTable, tenantTable } from '../../src/table'

// Tenant-scoped rows for the end-to-end tenancy composition test.
export const items = tenantTable(
	'items',
	{
		name: k.string(),
		ownerId: k.string(),
	},
	{
		commandFields: ['name'],
		publicFields: ['name'],
	},
)

// The app-table membership source the resolveOrganization hook reads from.
export const memberships = kTable('memberships', {
	userId: k.string(),
	organizationId: k.string(),
	roleSlug: k.string(),
	active: k.boolean(),
})

const tenantTables = {
	items: items.table.index('by_tenant', ['tenant']),
}
const platformTables = {
	memberships: memberships.table.index('by_user', ['userId']),
}

export default defineSchema(createModule(tenantTables, platformTables))
