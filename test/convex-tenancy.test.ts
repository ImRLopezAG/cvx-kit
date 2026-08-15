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

	it('systemQuery is internal, include-equipped, and RLS-unwrapped', async () => {
		const t = harness()
		await t.mutation(api.seedGlobal, {})
		expect(await t.query(api.countGlobals, {})).toBe(1)
	})
})

describe('pagination bridge under tenancy', () => {
	async function seed(t: ReturnType<typeof harness>) {
		// Interleave tenants so RLS rejects rows mid-page on full scans.
		for (let index = 0; index < 4; index++) {
			await t
				.withIdentity(orgOneOwner)
				.mutation(api.create, { name: `one-${index}` })
			await t
				.withIdentity(orgTwoOwner)
				.mutation(api.create, { name: `two-${index}` })
		}
	}

	it('paginates tenant-scoped pages with chaining cursors', async () => {
		const t = harness()
		await seed(t)
		const asOne = t.withIdentity(orgOneOwner)
		const first = await asOne.query(api.listPage, {
			numItems: 3,
			cursor: null,
		})
		expect(first.page.map((p: { name: string }) => p.name)).toEqual([
			'one-0',
			'one-1',
			'one-2',
		])
		expect(first.isDone).toBe(false)
		const second = await asOne.query(api.listPage, {
			numItems: 3,
			cursor: first.continueCursor,
		})
		expect(second.page.map((p: { name: string }) => p.name)).toEqual(['one-3'])
		expect(second.isDone).toBe(true)
	})

	it('returns short pages under RLS filtering but completes traversal', async () => {
		const t = harness()
		await seed(t)
		const asOne = t.withIdentity(orgOneOwner)
		const names: string[] = []
		let cursor: string | null = null
		let pages = 0
		while (pages < 10) {
			const result: {
				page: { name: string }[]
				isDone: boolean
				continueCursor: string
			} = await asOne.query(api.listPageUnscoped, { numItems: 3, cursor })
			names.push(...result.page.map((p) => p.name))
			pages += 1
			if (result.isDone) break
			cursor = result.continueCursor
		}
		// Only tenant rows ever surface, and every tenant row is reached.
		expect(names.every((name) => name.startsWith('one-'))).toBe(true)
		expect(names.sort()).toEqual(['one-0', 'one-1', 'one-2', 'one-3'])
	})

	it('rejects page sizes above the bound', async () => {
		const t = harness()
		await expect(
			t
				.withIdentity(orgOneOwner)
				.query(api.listPage, { numItems: 101, cursor: null }),
		).rejects.toThrow(/INVALID_REQUEST_BOUNDARY|1 to 100/)
	})
})
