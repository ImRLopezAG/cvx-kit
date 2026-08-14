import { defineSchema } from 'convex/server'
import { z } from 'zod'
import { createModule, tenantTable, zodTable } from '../../src/zod-table'

export const projects = tenantTable(
	'projects',
	() => ({
		name: z.string(),
		ownerId: z.string(),
	}),
	{
		publicFields: ['name'],
	},
)

// Deliberately NOT in the tenancy registry: default-deny must hide it.
export const globals = zodTable('globals', () => ({
	note: z.string(),
}))

const projectTables = {
	projects: projects.table.index('by_tenant', ['tenant']),
}
const platformTables = {
	globals: globals.table,
}

export default defineSchema(createModule(projectTables, platformTables))
