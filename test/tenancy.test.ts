import { defineSchema, defineTable, type DataModelFromSchemaDefinition } from 'convex/server'
import { v } from 'convex/values'
import { zid } from 'convex-helpers/server/zod4'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import {
	assertTenantOwned,
	composeRules,
	createTenantRules,
	requireTenantReference,
	type Rules,
} from '../src/tenancy'
import { KitError } from '../src/errors'
import { createModule, tenantTable, zodTable } from '../src/zod-table'

const ruleSchema = defineSchema({
	projects: defineTable({ tenant: v.optional(v.string()) }),
	audits: defineTable({}),
})
type RuleDataModel = DataModelFromSchemaDefinition<typeof ruleSchema>
const projectRow = { _id: zid('projects').parse('projects:1'), _creationTime: 0 }
const auditRow = { _id: zid('audits').parse('audits:1'), _creationTime: 0 }

describe('createTenantRules', () => {
	const rules = createTenantRules<RuleDataModel>('org_1', ['projects'])

	it('passes rows owned by the tenant and rejects everything else', async () => {
		for (const operation of ['read', 'insert', 'modify'] as const) {
			expect(await rules.projects?.[operation]?.({}, { ...projectRow, tenant: 'org_1' })).toBe(true)
			expect(await rules.projects?.[operation]?.({}, { ...projectRow, tenant: 'org_2' })).toBe(
				false,
			)
			expect(await rules.projects?.[operation]?.({}, projectRow)).toBe(false)
		}
	})
})

describe('composeRules', () => {
	it('ANDs rules across sets and keeps single-set operations', async () => {
		const tenant = createTenantRules<RuleDataModel>('org_1', ['projects'])
		const roles = {
			projects: { modify: async () => false },
			audits: { read: async () => true },
		} satisfies Rules<Record<never, never>, RuleDataModel>
		const composed = composeRules(tenant, roles)

		// read: only the tenant rule exists — passes for owned rows
		expect(await composed.projects?.read?.({}, { ...projectRow, tenant: 'org_1' })).toBe(true)
		// modify: tenant passes but role rule denies — AND fails
		expect(await composed.projects?.modify?.({}, { ...projectRow, tenant: 'org_1' })).toBe(false)
		// table present in only one set carries through
		expect(await composed.audits?.read?.({}, auditRow)).toBe(true)
		expect(composed.audits?.modify).toBeUndefined()
	})
})

describe('tenant reference guards', () => {
	it('fails identically for missing and foreign rows (no disclosure)', async () => {
		const missing = await requireTenantReference('org_1', async () => null).catch(
			(cause: unknown) => cause,
		)
		const foreign = await requireTenantReference('org_1', async () => ({
			tenant: 'org_2',
		})).catch((cause: unknown) => cause)
		expect(missing).toBeInstanceOf(KitError)
		expect(foreign).toBeInstanceOf(KitError)
		if (!(missing instanceof KitError) || !(foreign instanceof KitError))
			throw new Error('Expected both lookups to reject with KitError')
		// Identical failure: existence is never disclosed.
		expect(missing.code).toBe('REFERENCE_NOT_FOUND')
		expect(foreign.code).toBe('REFERENCE_NOT_FOUND')
		expect(foreign.message).toBe(missing.message)
		await expect(
			requireTenantReference('org_1', async () => ({ tenant: 'org_1' })),
		).resolves.toEqual({ tenant: 'org_1' })
	})

	it('assertTenantOwned throws a typed cross-tenant error', () => {
		expect(() => assertTenantOwned('org_1', { tenant: 'org_2' })).toThrow(KitError)
		expect(assertTenantOwned('org_1', { tenant: 'org_1' })).toEqual({
			tenant: 'org_1',
		})
	})
})

describe('tenantTable boundaries', () => {
	const projects = tenantTable('projects', () => ({ name: z.string(), ownerId: z.string() }), {
		publicFields: ['name', 'tenant'],
	})

	it('stores tenant but excludes it from every write boundary', () => {
		expect(Object.keys(projects.storage.shape)).toContain('tenant')
		expect(Object.keys(projects.insertSchema.shape)).not.toContain('tenant')
		expect(Object.keys(projects.updateSchema.shape)).not.toContain('tenant')
		expect(Object.keys(projects.commandInput.shape)).not.toContain('tenant')
	})

	it('exposes tenant in DTOs only by explicit allowlist', () => {
		expect(
			projects.toPublicDto({
				name: 'a',
				ownerId: 'u',
				tenant: 'org_1',
			}),
		).toEqual({ name: 'a', tenant: 'org_1' })
	})
})

describe('createModule', () => {
	it('merges module maps and rejects duplicate owners', () => {
		const a = { projects: zodTable('projects', () => ({ name: z.string() })).table }
		const b = { audits: zodTable('audits', () => ({ action: z.string() })).table }
		expect(createModule(a, b)).toEqual({
			projects: a.projects,
			audits: b.audits,
		})
		expect(() => createModule(a, a)).toThrow(/more than one module/)
	})
})
