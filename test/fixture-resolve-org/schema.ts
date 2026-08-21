import { defineSchema } from 'convex/server'
import { z } from 'zod'
import { createModule, tenantTable, zodTable } from '../../src/zod-table'

// Tenant-scoped rows for the end-to-end tenancy composition test.
export const items = tenantTable(
	'items',
	() => ({
		name: z.string(),
		ownerId: z.string(),
	}),
	{
		commandFields: ['name'],
		publicFields: ['name'],
	},
)

// The app-table membership source the resolveOrganization hook reads from.
export const memberships = zodTable('memberships', () => ({
	userId: z.string(),
	organizationId: z.string(),
	roleSlug: z.string(),
	active: z.boolean(),
}))

const tenantTables = {
	items: items.table.index('by_tenant', ['tenant']),
}
const platformTables = {
	memberships: memberships.table.index('by_user', ['userId']),
}

export default defineSchema(createModule(tenantTables, platformTables))
