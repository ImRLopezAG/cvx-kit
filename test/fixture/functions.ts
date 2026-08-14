import {
	actionGeneric,
	internalActionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	mutationGeneric,
	queryGeneric,
	type GenericDataModel,
} from 'convex/server'
import { z } from 'zod'
import { createAuthFunctions } from '../../src/auth'
import { appendOnly, createTriggers, timestamps } from '../../src/triggers'
import { documents } from './schema'

/** The fixture app's own role vocabulary — deliberately not reader/writer/admin. */
type FixtureRole = 'viewer' | 'editor' | 'owner'

const FIXTURE_ROLES = ['viewer', 'editor', 'owner'] as const

export const triggers = createTriggers<GenericDataModel>()
appendOnly(triggers, 'documentHistory')
timestamps(triggers, 'documents')
// Evaluation trigger: every document insert writes a history evidence row.
triggers.register('documents', async (ctx, change) => {
	if (change.operation !== 'insert') return
	await ctx.innerDb.insert('documentHistory', {
		documentTitle: (change.newDoc as { title: string }).title,
		actorId: (change.newDoc as { ownerId: string }).ownerId,
	} as never)
})

export const auth = createAuthFunctions<GenericDataModel, FixtureRole>({
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
	mapRole: (slug) =>
		FIXTURE_ROLES.includes(slug as FixtureRole) ? (slug as FixtureRole) : null,
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
		ctx.include(ctx.db.query('documents')).execute(10, (rows) =>
			rows
				.filter((row) => (row as { ownerId: string }).ownerId === ctx.actor.userId)
				.map((row) => documents.toPublicDto(row as never)),
		),
})

export const purge = auth.roleMutation('owner')({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query('documents').collect()
		for (const row of rows) await ctx.db.delete(row._id as never)
		return rows.length
	},
})

export const history = auth.authQuery({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query('documentHistory').collect()
		return rows.map((row) => ({
			documentTitle: (row as never as { documentTitle: string }).documentTitle,
			actorId: (row as never as { actorId: string }).actorId,
		}))
	},
})

export const tamperHistory = auth.authMutation({
	args: { title: z.string() },
	handler: async (ctx, args) => {
		const first = await ctx.db.query('documentHistory').first()
		if (!first) throw new Error('no history to tamper with')
		await ctx.db.patch(first._id as never, { documentTitle: args.title })
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
		if (first) await ctx.db.patch(first._id as never, { title: args.title })
		return null
	},
})
