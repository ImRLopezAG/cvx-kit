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
import { createTriggers, tenantOwnership, timestamps } from '../../src/triggers'
import { projects } from './schema'

type FixtureRole = 'viewer' | 'editor' | 'owner'

const FIXTURE_ROLES = ['viewer', 'editor', 'owner'] as const

// One registry drives schema guards and row-level security alike.
const TENANT_TABLES = ['projects'] as const

export const triggers = createTriggers<GenericDataModel>()
timestamps(triggers, 'projects')
tenantOwnership(triggers, ...TENANT_TABLES)

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
	security: {
		tenancy: { tables: TENANT_TABLES },
		// Role-level security composed onto tenant isolation: only owners
		// may modify project rows, whatever the handler tries.
		rules: (bundle) => ({
			projects: {
				modify: async () => bundle.role === 'owner',
			},
		}),
	},
})

export const create = auth.authMutation({
	args: { name: z.string() },
	handler: async (ctx, args) => {
		await ctx.db.insert('projects', {
			name: args.name,
			ownerId: ctx.actor.userId,
			tenant: ctx.tenant,
		})
		return null
	},
})

export const createForeign = auth.authMutation({
	args: { name: z.string() },
	handler: async (ctx, args) => {
		await ctx.db.insert('projects', {
			name: args.name,
			ownerId: ctx.actor.userId,
			tenant: 'org_someone_else',
		})
		return null
	},
})

/** Full table scan on purpose: RLS must scope it to the caller's tenant. */
export const listAll = auth.authQuery({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query('projects').collect()
		return rows.map((row) => projects.toPublicDto(row as never))
	},
})

export const rename = auth.authMutation({
	args: { name: z.string() },
	handler: async (ctx, args) => {
		const first = await ctx.db.query('projects').first()
		if (!first) throw new Error('nothing to rename')
		await ctx.db.patch(first._id as never, { name: args.name })
		return null
	},
})

export const steal = auth.authMutation({
	args: {},
	handler: async (ctx) => {
		const first = await ctx.db.query('projects').first()
		if (!first) throw new Error('nothing to steal')
		await ctx.db.patch(first._id as never, { tenant: 'org_thief' } as never)
		return null
	},
})

export const readGlobals = auth.authQuery({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query('globals').collect()
		return rows.length
	},
})

export const countGlobals = auth.systemQuery({
	args: {},
	handler: async (ctx) => {
		// system* stays unwrapped: internal reads see every table.
		const rows = await ctx.db.query('globals').collect()
		return rows.length
	},
})

export const seedGlobal = auth.systemMutation({
	args: {},
	handler: async (ctx) => {
		// system* stays unwrapped: trusted internal paths reach every table.
		await ctx.db.insert('globals', { note: 'platform state' } as never)
		return null
	},
})
