// @vitest-environment edge-runtime
// The createAuthFunctions runtime suite (convex-auth.test.ts) against the v2 constructors, with the
// fixture functions declared through `k`.
import { convexTest } from 'convex-test'
import {
	actionGeneric,
	anyApi,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	type DataModelFromSchemaDefinition,
} from 'convex/server'
import { describe, expect, it } from 'vite-plus/test'
import { createKAuthFunctions } from '../src/auth'
import { k } from '../src/k'
import { appendOnly, createTriggers, timestamps } from '../src/triggers'
import schema, { documents } from './fixture/schema'

type FixtureDataModel = DataModelFromSchemaDefinition<typeof schema>
type FixtureRole = 'viewer' | 'editor' | 'owner'
const FIXTURE_ROLES = ['viewer', 'editor', 'owner'] as const

const triggers = createTriggers<FixtureDataModel>()
appendOnly(triggers, 'documentHistory')
timestamps(triggers, 'documents')
triggers.register('documents', async (ctx, change) => {
	if (change.operation !== 'insert') return
	await ctx.innerDb.insert('documentHistory', {
		documentTitle: change.newDoc.title,
		actorId: change.newDoc.ownerId,
	})
})

const auth = createKAuthFunctions<FixtureDataModel, FixtureRole>({
	triggers,
	query: queryGeneric,
	mutation: mutationGeneric,
	action: actionGeneric,
	internalMutation: internalMutationGeneric,
	internalAction: internalActionGeneric,
	internalQuery: internalQueryGeneric,
	getAuthUser: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity()
		return identity ? { id: identity.subject } : null
	},
	mapRole: (slug) => FIXTURE_ROLES.find((role) => role === slug) ?? null,
	adminRoles: ['owner'],
})

const functions = {
	create: auth.authMutation({
		args: { title: k.string(), secretNote: k.string() },
		handler: async (ctx, args) => {
			await ctx.db.insert('documents', {
				title: args.title,
				secretNote: args.secretNote,
				ownerId: ctx.actor.userId,
			})
			return null
		},
	}),
	mine: auth.authQuery({
		args: {},
		handler: (ctx) =>
			ctx
				.include(ctx.db.query('documents'))
				.execute(10, (rows) =>
					rows
						.filter((row) => row.ownerId === ctx.actor.userId)
						.map((row) => documents.toPublicDto(row)),
				),
	}),
	purge: auth.roleMutation('owner')({
		args: {},
		handler: async (ctx) => {
			const rows = await ctx.db.query('documents').collect()
			for (const row of rows) await ctx.db.delete(row._id)
			return rows.length
		},
	}),
	history: auth.authQuery({
		args: {},
		handler: async (ctx) => {
			const rows = await ctx.db.query('documentHistory').collect()
			return rows.map((row) => ({ documentTitle: row.documentTitle, actorId: row.actorId }))
		},
	}),
	tamperHistory: auth.authMutation({
		args: { title: k.string() },
		handler: async (ctx, args) => {
			const first = await ctx.db.query('documentHistory').first()
			if (!first) throw new Error('no history to tamper with')
			await ctx.db.patch(first._id, { documentTitle: args.title })
			return null
		},
	}),
	editorsRename: auth.roleMutation(
		'editor',
		'owner',
	)({
		args: { title: k.string().trim().min(1) },
		handler: async (ctx, args) => {
			const first = await ctx.db.query('documents').first()
			if (first) await ctx.db.patch(first._id, { title: args.title })
			return null
		},
	}),
}

const api = anyApi.functions

function harness() {
	return convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => functions,
	})
}

const editorIdentity = { subject: 'user_editor', org_id: 'org_1', role: 'editor' }
const viewerIdentity = { subject: 'user_viewer', org_id: 'org_1', role: 'viewer' }
const ownerIdentity = { subject: 'user_owner', org_id: 'org_1', role: 'owner' }

describe('createKAuthFunctions on the real Convex runtime', () => {
	it.each([null, 'invalid', [], { organizationId: 42, role: false }])(
		'falls back to top-level claims for malformed organization claims: %j',
		async (organization) => {
			const t = harness().withIdentity({ ...editorIdentity, organization })
			await expect(t.query(api.mine, {})).resolves.toEqual([])
		},
	)

	it('keeps nested claims authoritative over top-level claims', async () => {
		const t = harness().withIdentity({
			...editorIdentity,
			organization: { organizationId: 'org_nested', role: 'viewer' },
		})
		await expect(t.mutation(api.editorsRename, { title: 'nope' })).rejects.toThrow(/FORBIDDEN/)
	})

	it('falls back per claim when only one nested claim is malformed', async () => {
		const t = harness().withIdentity({
			...editorIdentity,
			organization: { organizationId: 7, role: 'viewer' },
		})
		await expect(t.mutation(api.editorsRename, { title: 'nope' })).rejects.toThrow(/FORBIDDEN/)
		await expect(t.query(api.mine, {})).resolves.toEqual([])
	})

	it('rejects an empty nested organization without falling back', async () => {
		const t = harness().withIdentity({
			...editorIdentity,
			organization: { organizationId: '', role: 'editor' },
		})
		await expect(t.query(api.mine, {})).rejects.toThrow(/UNAUTHENTICATED/)
	})

	it('rejects unauthenticated callers', async () => {
		await expect(harness().query(api.mine, {})).rejects.toThrow(/UNAUTHENTICATED/)
	})

	it('rejects identities whose role is outside the app vocabulary', async () => {
		const t = harness().withIdentity({ subject: 'user_x', org_id: 'org_1', role: 'superuser' })
		await expect(t.query(api.mine, {})).rejects.toThrow(/FORBIDDEN/)
	})

	it('authenticates, writes with the actor, and redacts DTOs', async () => {
		const asEditor = harness().withIdentity(editorIdentity)
		await asEditor.mutation(api.create, { title: 'Plan', secretNote: 'do not leak' })
		const mine = await asEditor.query(api.mine, {})
		expect(mine).toEqual([{ title: 'Plan', ownerId: 'user_editor' }])
		expect(JSON.stringify(mine)).not.toContain('do not leak')
	})

	it('scopes reads to the calling actor', async () => {
		const t = harness()
		const asEditor = t.withIdentity(editorIdentity)
		const asOther = t.withIdentity({ subject: 'user_other', org_id: 'org_1', role: 'viewer' })
		await asEditor.mutation(api.create, { title: 'Mine', secretNote: 's' })
		expect(await asOther.query(api.mine, {})).toEqual([])
	})

	it('gates role-based mutations to the allowed roles and checks their args', async () => {
		const t = harness()
		const asEditor = t.withIdentity(editorIdentity)
		const asViewer = t.withIdentity(viewerIdentity)
		const asOwner = t.withIdentity(ownerIdentity)
		await asEditor.mutation(api.create, { title: 'Doc', secretNote: 's' })
		await expect(asViewer.mutation(api.purge, {})).rejects.toThrow(/FORBIDDEN/)
		// The role gate runs before the declared min(1) check.
		await expect(asViewer.mutation(api.editorsRename, { title: ' ' })).rejects.toThrow(/FORBIDDEN/)
		await expect(asEditor.mutation(api.editorsRename, { title: ' ' })).rejects.toMatchObject({
			data: { code: 'VALIDATION', issues: [{ path: ['title'], code: 'too_small' }] },
		})
		await asEditor.mutation(api.editorsRename, { title: ' Renamed ' })
		expect(await asEditor.query(api.mine, {})).toEqual([
			{ title: 'Renamed', ownerId: 'user_editor' },
		])
		expect(await asOwner.mutation(api.purge, {})).toBe(1)
	})

	it('fires registered triggers structurally through authMutation', async () => {
		const asEditor = harness().withIdentity(editorIdentity)
		await asEditor.mutation(api.create, { title: 'Audited doc', secretNote: 's' })
		expect(await asEditor.query(api.history, {})).toEqual([
			{ documentTitle: 'Audited doc', actorId: 'user_editor' },
		])
	})

	it('maintains timestamps through the timestamps trigger', async () => {
		const t = harness()
		await t.withIdentity(editorIdentity).mutation(api.create, { title: 'Stamped', secretNote: 's' })
		const stamped = await t.run(async (ctx) => await ctx.db.query('documents').first())
		expect(stamped?.createdAt).toEqual(expect.any(Number))
		expect(stamped?.updatedAt).toEqual(expect.any(Number))
	})

	it('enforces append-only evidence tables registered via appendOnly()', async () => {
		const asEditor = harness().withIdentity(editorIdentity)
		await asEditor.mutation(api.create, { title: 'Doc', secretNote: 's' })
		await expect(asEditor.mutation(api.tamperHistory, { title: 'rewritten' })).rejects.toThrow(
			/append-only/,
		)
	})

	it('rejects viewers from admin (owner-gated) constructors but allows owners', async () => {
		const t = harness()
		await expect(t.withIdentity(viewerIdentity).mutation(api.purge, {})).rejects.toThrow(
			/FORBIDDEN/,
		)
		expect(await t.withIdentity(ownerIdentity).mutation(api.purge, {})).toBe(0)
	})
})
