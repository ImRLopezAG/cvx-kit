import type { GenericDataModel } from 'convex/server'
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
import { createModule, tenantTable } from '../src/zod-table'

type AnyRules = Rules<unknown, GenericDataModel> &
	Record<
		string,
		{
			read?: (ctx: unknown, doc: unknown) => Promise<boolean>
			insert?: (ctx: unknown, doc: unknown) => Promise<boolean>
			modify?: (ctx: unknown, doc: unknown) => Promise<boolean>
		}
	>

describe('createTenantRules', () => {
	const rules = createTenantRules('org_1', ['projects'] as never) as AnyRules

	it('passes rows owned by the tenant and rejects everything else', async () => {
		for (const operation of ['read', 'insert', 'modify'] as const) {
			expect(await rules.projects[operation]?.({}, { tenant: 'org_1' })).toBe(
				true,
			)
			expect(await rules.projects[operation]?.({}, { tenant: 'org_2' })).toBe(
				false,
			)
			expect(await rules.projects[operation]?.({}, {})).toBe(false)
		}
	})
})

describe('composeRules', () => {
	it('ANDs rules across sets and keeps single-set operations', async () => {
		const tenant = createTenantRules('org_1', ['projects'] as never)
		const roles = {
			projects: { modify: async () => false },
			audits: { read: async () => true },
		} as never as Rules<unknown, GenericDataModel>
		const composed = composeRules(tenant, roles) as AnyRules

		// read: only the tenant rule exists — passes for owned rows
		expect(await composed.projects.read?.({}, { tenant: 'org_1' })).toBe(true)
		// modify: tenant passes but role rule denies — AND fails
		expect(await composed.projects.modify?.({}, { tenant: 'org_1' })).toBe(
			false,
		)
		// table present in only one set carries through
		expect(await composed.audits.read?.({}, {})).toBe(true)
		expect(composed.audits.modify).toBeUndefined()
	})
})

describe('tenant reference guards', () => {
	it('fails identically for missing and foreign rows (no disclosure)', async () => {
		const missing = await requireTenantReference(
			'org_1',
			async () => null,
		).catch((error: unknown) => error)
		const foreign = await requireTenantReference('org_1', async () => ({
			tenant: 'org_2',
		})).catch((error: unknown) => error)
		expect(missing).toBeInstanceOf(KitError)
		expect(foreign).toBeInstanceOf(KitError)
		// Identical failure: existence is never disclosed.
		expect((missing as KitError).code).toBe('REFERENCE_NOT_FOUND')
		expect((foreign as KitError).code).toBe('REFERENCE_NOT_FOUND')
		expect((foreign as KitError).message).toBe((missing as KitError).message)
		await expect(
			requireTenantReference('org_1', async () => ({ tenant: 'org_1' })),
		).resolves.toEqual({ tenant: 'org_1' })
	})

	it('assertTenantOwned throws a typed cross-tenant error', () => {
		expect(() => assertTenantOwned('org_1', { tenant: 'org_2' })).toThrow(
			KitError,
		)
		expect(assertTenantOwned('org_1', { tenant: 'org_1' })).toEqual({
			tenant: 'org_1',
		})
	})
})

describe('tenantTable boundaries', () => {
	const projects = tenantTable(
		'projects',
		() => ({ name: z.string(), ownerId: z.string() }),
		{ publicFields: ['name', 'tenant'] },
	)

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
			} as never),
		).toEqual({ name: 'a', tenant: 'org_1' })
	})
})

describe('createModule', () => {
	it('merges module maps and rejects duplicate owners', () => {
		const a = { projects: 'tableA' } as never
		const b = { audits: 'tableB' } as never
		expect(createModule(a, b)).toEqual({
			projects: 'tableA',
			audits: 'tableB',
		})
		expect(() => createModule(a, a)).toThrow(/more than one module/)
	})
})
