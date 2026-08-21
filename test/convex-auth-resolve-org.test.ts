// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { anyApi } from 'convex/server'
import { describe, expect, it } from 'vite-plus/test'

import schema from './fixture-resolve-org/schema'

const modules = import.meta.glob('./fixture-resolve-org/**/*.ts')
const api = anyApi.functions

function harness() {
	return convexTest(schema, modules)
}

/** Base identities in this suite carry NO org_id/role claims. */
function claimless(subject: string) {
	return { subject }
}

async function seed(
	t: ReturnType<typeof harness>,
	membership: {
		userId: string
		organizationId: string
		roleSlug: string
		active?: boolean
	},
) {
	await t.mutation(api.seedMembership, {
		active: true,
		...membership,
	})
}

describe('resolveOrganization hook on the real Convex runtime', () => {
	it('authenticates claim-less identities from a membership row (query + mutation)', async () => {
		const t = harness()
		await seed(t, {
			userId: 'user_happy',
			organizationId: 'org_happy',
			roleSlug: 'editor',
		})
		const asUser = t.withIdentity(claimless('user_happy'))

		const fromQuery = await asUser.query(api.whoami, {})
		expect(fromQuery).toEqual({
			userId: 'user_happy',
			organizationId: 'org_happy',
			role: 'editor',
		})

		const fromMutation = await asUser.mutation(api.whoamiMutation, {})
		expect(fromMutation.organizationId).toBe('org_happy')
	})

	it('rejects with FORBIDDEN when the hook returns null (no membership row)', async () => {
		const t = harness()
		const asUser = t.withIdentity(claimless('user_no_membership'))
		await expect(asUser.query(api.whoami, {})).rejects.toThrow(/FORBIDDEN/)
	})

	it('rejects with FORBIDDEN when the hook returns a roleSlug outside the vocabulary', async () => {
		const t = harness()
		await seed(t, {
			userId: 'user_badrole',
			organizationId: 'org_badrole',
			roleSlug: 'superuser',
		})
		const asUser = t.withIdentity(claimless('user_badrole'))
		await expect(asUser.query(api.whoami, {})).rejects.toThrow(/FORBIDDEN/)
	})

	it('keeps missing identity UNAUTHENTICATED even with the hook configured', async () => {
		const t = harness()
		await expect(t.query(api.whoami, {})).rejects.toThrow(/UNAUTHENTICATED/)
	})

	it('fails closed with FORBIDDEN when the hook throws', async () => {
		const t = harness()
		const asUser = t.withIdentity(claimless('user_boom'))
		await expect(asUser.query(api.whoami, {})).rejects.toThrow(/FORBIDDEN/)
	})

	it('overrides present-but-different org claims with the membership row', async () => {
		const t = harness()
		await seed(t, {
			userId: 'user_override',
			organizationId: 'org_db',
			roleSlug: 'editor',
		})
		const asUser = t.withIdentity({
			subject: 'user_override',
			org_id: 'org_claims',
			role: 'editor',
		})
		const actor = await asUser.query(api.whoami, {})
		expect(actor.organizationId).toBe('org_db')
	})

	it('bypasses claim parsing entirely: malformed claims still authenticate via the row', async () => {
		const t = harness()
		await seed(t, {
			userId: 'user_bypass',
			organizationId: 'org_db_bypass',
			roleSlug: 'viewer',
		})
		const asUser = t.withIdentity({
			subject: 'user_bypass',
			org_id: 'org_unknown_garbage',
			role: 'superuser', // unknown role claim must not matter
		})
		const actor = await asUser.query(api.whoami, {})
		expect(actor).toEqual({
			userId: 'user_bypass',
			organizationId: 'org_db_bypass',
			role: 'viewer',
		})
	})

	it('authenticates a claims-less identity through an authAction (runQuery-based hook)', async () => {
		const t = harness()
		await seed(t, {
			userId: 'user_action',
			organizationId: 'org_action',
			roleSlug: 'editor',
		})
		const asUser = t.withIdentity(claimless('user_action'))
		const actor = await asUser.action(api.whoamiAction, {})
		expect(actor.organizationId).toBe('org_action')
	})

	it('passes the hook-resolved organizationId into verifyMembership for actions', async () => {
		const t = harness()
		await seed(t, {
			userId: 'user_verify',
			organizationId: 'org_db_verify',
			roleSlug: 'editor',
		})
		const asUser = t.withIdentity(claimless('user_verify'))
		const actor = await asUser.action(api.whoamiAction, {})
		expect(actor.organizationId).toBe('org_db_verify')

		const calls = await t.query(api.recordedVerifyCalls, {
			userId: 'user_verify',
		})
		expect(calls).toEqual([
			{
				userId: 'user_verify',
				organizationId: 'org_db_verify',
			},
		])
	})

	it('actions prefer the hook-resolved organization over conflicting claims', async () => {
		const t = harness()
		await seed(t, {
			userId: 'user_claims_action',
			organizationId: 'org_membership_action',
			roleSlug: 'editor',
		})
		// Identity carries conflicting-but-plausible claims: a different org_id
		// and a role that maps to a valid role. The hook result must win.
		const asUser = t.withIdentity({
			subject: 'user_claims_action',
			org_id: 'org_claims_action',
			role: 'viewer',
		})
		const actor = await asUser.action(api.whoamiAction, {})
		expect(actor.organizationId).toBe('org_membership_action')
		expect(actor.role).toBe('editor')

		// verifyMembership must have been called with the hook-resolved org,
		// never the claims org. Calls are scoped to this test's unique userId.
		const calls = await t.query(api.recordedVerifyCalls, {
			userId: 'user_claims_action',
		})
		expect(calls).toEqual([
			{
				userId: 'user_claims_action',
				organizationId: 'org_membership_action',
			},
		])
	})

	it('rejects actions with FORBIDDEN when verifyMembership mismatches the hook org', async () => {
		const t = harness()
		await seed(t, {
			userId: 'user_verify_bad',
			organizationId: 'org_db_bad',
			roleSlug: 'editor',
		})
		const asUser = t.withIdentity(claimless('user_verify_bad'))
		await expect(asUser.action(api.whoamiAction, {})).rejects.toThrow(
			/FORBIDDEN/,
		)
	})

	it('never hands user A the membership of user B (identity binding)', async () => {
		const t = harness()
		await seed(t, {
			userId: 'user_b',
			organizationId: 'org_b',
			roleSlug: 'editor',
		})
		// user A has no membership: must be FORBIDDEN, never org_b.
		const asA = t.withIdentity(claimless('user_a'))
		await expect(asA.query(api.whoami, {})).rejects.toThrow(/FORBIDDEN/)

		// user B keeps their own org.
		const asB = t.withIdentity(claimless('user_b'))
		const actorB = await asB.query(api.whoami, {})
		expect(actorB.userId).toBe('user_b')
		expect(actorB.organizationId).toBe('org_b')
	})

	it('rejects revoked memberships with FORBIDDEN on queries and mutations', async () => {
		const t = harness()
		await seed(t, {
			userId: 'user_revoked',
			organizationId: 'org_revoked',
			roleSlug: 'editor',
			active: false,
		})
		const asUser = t.withIdentity(claimless('user_revoked'))
		await expect(asUser.query(api.whoami, {})).rejects.toThrow(/FORBIDDEN/)
		await expect(asUser.mutation(api.whoamiMutation, {})).rejects.toThrow(
			/FORBIDDEN/,
		)
	})

	it('isolates hook-resolved tenants end-to-end through the RLS-wrapped db', async () => {
		const t = harness()
		await seed(t, {
			userId: 'user_t1',
			organizationId: 'org_t1',
			roleSlug: 'editor',
		})
		await seed(t, {
			userId: 'user_t2',
			organizationId: 'org_t2',
			roleSlug: 'editor',
		})
		const asT1 = t.withIdentity(claimless('user_t1'))
		const asT2 = t.withIdentity(claimless('user_t2'))

		await asT1.mutation(api.createItem, { name: 'tenant-one item' })
		await asT2.mutation(api.createItem, { name: 'tenant-two item' })

		expect(await asT1.query(api.listItems, {})).toEqual(['tenant-one item'])
		expect(await asT2.query(api.listItems, {})).toEqual(['tenant-two item'])
	})

	it('hook-less config: a claim-less identity stays UNAUTHENTICATED (regression)', async () => {
		const t = harness()
		const asUser = t.withIdentity(claimless('user_plain'))
		await expect(asUser.query(api.noHookWhoami, {})).rejects.toThrow(
			/UNAUTHENTICATED/,
		)
	})
})
