// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { anyApi } from 'convex/server'
import { describe, expect, it } from 'vite-plus/test'

import schema from './fixture/schema'

const modules = import.meta.glob('./fixture/**/*.ts')
const api = anyApi.functions

function harness() {
	return convexTest(schema, modules)
}

const editorIdentity = {
	subject: 'user_editor',
	org_id: 'org_1',
	role: 'editor',
}

describe('createAuthFunctions on the real Convex runtime', () => {
	it('rejects unauthenticated callers', async () => {
		const t = harness()
		await expect(t.query(api.mine, {})).rejects.toThrow(/UNAUTHENTICATED/)
	})

	it('rejects identities whose role is outside the app vocabulary', async () => {
		const t = harness()
		const asStranger = t.withIdentity({
			subject: 'user_x',
			org_id: 'org_1',
			role: 'superuser',
		})
		await expect(asStranger.query(api.mine, {})).rejects.toThrow(/FORBIDDEN/)
	})

	it('authenticates, writes with the actor, and redacts DTOs', async () => {
		const t = harness()
		const asEditor = t.withIdentity(editorIdentity)
		await asEditor.mutation(api.create, {
			title: 'Plan',
			secretNote: 'do not leak',
		})
		const mine = await asEditor.query(api.mine, {})
		expect(mine).toEqual([{ title: 'Plan', ownerId: 'user_editor' }])
		expect(JSON.stringify(mine)).not.toContain('do not leak')
	})

	it('scopes reads to the calling actor', async () => {
		const t = harness()
		const asEditor = t.withIdentity(editorIdentity)
		const asOther = t.withIdentity({
			subject: 'user_other',
			org_id: 'org_1',
			role: 'viewer',
		})
		await asEditor.mutation(api.create, { title: 'Mine', secretNote: 's' })
		expect(await asOther.query(api.mine, {})).toEqual([])
	})

	it('gates role-based mutations to the allowed roles', async () => {
		const t = harness()
		const asEditor = t.withIdentity(editorIdentity)
		const asViewer = t.withIdentity({
			subject: 'user_viewer',
			org_id: 'org_1',
			role: 'viewer',
		})
		const asOwner = t.withIdentity({
			subject: 'user_owner',
			org_id: 'org_1',
			role: 'owner',
		})
		await asEditor.mutation(api.create, { title: 'Doc', secretNote: 's' })

		await expect(asViewer.mutation(api.purge, {})).rejects.toThrow(/FORBIDDEN/)
		await expect(
			asViewer.mutation(api.editorsRename, { title: 'nope' }),
		).rejects.toThrow(/FORBIDDEN/)

		await asEditor.mutation(api.editorsRename, { title: 'Renamed' })
		expect(await asOwner.mutation(api.purge, {})).toBe(1)
	})

	it('fires registered triggers structurally through authMutation', async () => {
		const t = harness()
		const asEditor = t.withIdentity(editorIdentity)
		await asEditor.mutation(api.create, {
			title: 'Audited doc',
			secretNote: 's',
		})
		expect(await asEditor.query(api.history, {})).toEqual([
			{ documentTitle: 'Audited doc', actorId: 'user_editor' },
		])
	})

	it('maintains opinionated timestamps through the timestamps trigger', async () => {
		const t = harness()
		const asEditor = t.withIdentity(editorIdentity)
		await asEditor.mutation(api.create, { title: 'Stamped', secretNote: 's' })
		const stamped = await t.run(async (ctx) => {
			return await ctx.db.query('documents').first()
		})
		expect(typeof (stamped as { createdAt?: number }).createdAt).toBe('number')
		expect(typeof (stamped as { updatedAt?: number }).updatedAt).toBe('number')
	})

	it('enforces append-only evidence tables registered via appendOnly()', async () => {
		const t = harness()
		const asEditor = t.withIdentity(editorIdentity)
		await asEditor.mutation(api.create, { title: 'Doc', secretNote: 's' })
		await expect(
			asEditor.mutation(api.tamperHistory, { title: 'rewritten' }),
		).rejects.toThrow(/append-only/)
	})

	it('rejects viewers from admin (owner-gated) constructors but allows owners', async () => {
		const t = harness()
		const asViewer = t.withIdentity({
			subject: 'user_viewer',
			org_id: 'org_1',
			role: 'viewer',
		})
		const asOwner = t.withIdentity({
			subject: 'user_owner',
			org_id: 'org_1',
			role: 'owner',
		})
		await expect(asViewer.mutation(api.purge, {})).rejects.toThrow(/FORBIDDEN/)
		expect(await asOwner.mutation(api.purge, {})).toBe(0)
	})
})
