// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { anyApi } from 'convex/server'
import { describe, expect, it } from 'vite-plus/test'

import schema from './fixture-tenant/schema'

const modules = import.meta.glob('./fixture-tenant/**/*.ts')
const api = anyApi.functions

function harness() {
	return convexTest(schema, modules)
}

const orgOneOwner = { subject: 'user_1', org_id: 'org_1', role: 'owner' }
const orgOneViewer = { subject: 'user_2', org_id: 'org_1', role: 'viewer' }
const orgTwoOwner = { subject: 'user_9', org_id: 'org_2', role: 'owner' }

describe('tenancy security on the real Convex runtime', () => {
	it('scopes even a full table scan to the caller tenant', async () => {
		const t = harness()
		await t.withIdentity(orgOneOwner).mutation(api.create, { name: 'One' })
		await t.withIdentity(orgTwoOwner).mutation(api.create, { name: 'Two' })

		expect(await t.withIdentity(orgOneOwner).query(api.listAll, {})).toEqual([
			{ name: 'One' },
		])
		expect(await t.withIdentity(orgTwoOwner).query(api.listAll, {})).toEqual([
			{ name: 'Two' },
		])
	})

	it('rejects inserts stamped with a foreign tenant', async () => {
		const t = harness()
		await expect(
			t.withIdentity(orgOneOwner).mutation(api.createForeign, { name: 'x' }),
		).rejects.toThrow()
	})

	it('composes role-level rules onto tenant isolation (AND)', async () => {
		const t = harness()
		await t.withIdentity(orgOneOwner).mutation(api.create, { name: 'One' })

		// Same tenant, insufficient role: modify rule denies.
		await expect(
			t.withIdentity(orgOneViewer).mutation(api.rename, { name: 'nope' }),
		).rejects.toThrow()
		// Owner passes both tenant and role rules.
		await t.withIdentity(orgOneOwner).mutation(api.rename, { name: 'yep' })
		expect(await t.withIdentity(orgOneOwner).query(api.listAll, {})).toEqual([
			{ name: 'yep' },
		])
	})

	it('blocks tenant reassignment via the post-image trigger', async () => {
		const t = harness()
		await t.withIdentity(orgOneOwner).mutation(api.create, { name: 'One' })
		await expect(
			t.withIdentity(orgOneOwner).mutation(api.steal, {}),
		).rejects.toThrow(/reassigned/)
	})

	it('default-deny hides tables outside the tenancy registry', async () => {
		const t = harness()
		await t.mutation(api.seedGlobal, {})
		expect(await t.withIdentity(orgOneOwner).query(api.readGlobals, {})).toBe(0)
	})
})
