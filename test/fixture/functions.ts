import type schema from './schema'
type FixtureDataModel = DataModelFromSchemaDefinition<typeof schema>
import {
	actionGeneric,
	internalActionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	mutationGeneric,
	queryGeneric,
	type DataModelFromSchemaDefinition,
} from 'convex/server'
import { z } from 'zod'
import { createAuthFunctions } from '../../src/auth'
import { appendOnly, createTriggers, timestamps } from '../../src/triggers'
import { documents } from './schema'

/** The fixture app's own role vocabulary — deliberately not reader/writer/admin. */
type FixtureRole = 'viewer' | 'editor' | 'owner'

const FIXTURE_ROLES = ['viewer', 'editor', 'owner'] as const

export const triggers = createTriggers<FixtureDataModel>()
appendOnly(triggers, 'documentHistory')
timestamps(triggers, 'documents')
// Evaluation trigger: every document insert writes a history evidence row.
triggers.register('documents', async (ctx, change) => {
	if (change.operation !== 'insert') return
	await ctx.innerDb.insert('documentHistory', {
		documentTitle: change.newDoc.title,
		actorId: change.newDoc.ownerId,
	})
})

export const auth = createAuthFunctions<FixtureDataModel, FixtureRole>({
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

export const create = auth.authMutation({
	args: { title: z.string(), secretNote: z.string() },
	handler: async (ctx, args) => {
		await ctx.db.insert('documents', {
			title: args.title,
			secretNote: args.secretNote,
			ownerId: ctx.actor.userId,
		})
		return null
	},
})

export const mine = auth.authQuery({
	args: {},
	handler: (ctx) =>
		ctx
			.include(ctx.db.query('documents'))
			.execute(10, (rows) =>
				rows
					.filter((row) => row.ownerId === ctx.actor.userId)
					.map((row) => documents.toPublicDto(row)),
			),
})

export const purge = auth.roleMutation('owner')({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query('documents').collect()
		for (const row of rows) await ctx.db.delete(row._id)
		return rows.length
	},
})

export const history = auth.authQuery({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query('documentHistory').collect()
		return rows.map((row) => ({
			documentTitle: row.documentTitle,
			actorId: row.actorId,
		}))
	},
})

export const tamperHistory = auth.authMutation({
	args: { title: z.string() },
	handler: async (ctx, args) => {
		const first = await ctx.db.query('documentHistory').first()
		if (!first) throw new Error('no history to tamper with')
		await ctx.db.patch(first._id, { documentTitle: args.title })
		return null
	},
})

export const editorsRename = auth.roleMutation(
	'editor',
	'owner',
)({
	args: { title: z.string() },
	handler: async (ctx, args) => {
		const first = await ctx.db.query('documents').first()
		if (first) await ctx.db.patch(first._id, { title: args.title })
		return null
	},
})
