import {
	actionGeneric,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	type GenericDataModel,
} from 'convex/server'
import { z } from 'zod'
import { createAuthFunctions } from '../../src/auth'
import { internal } from './_generated/api'

type FixtureRole = 'viewer' | 'editor' | 'owner'

const FIXTURE_ROLES = ['viewer', 'editor', 'owner'] as const

const TENANT_TABLES = ['items'] as const

type MembershipRow = {
	userId: string
	organizationId: string
	roleSlug: string
	active: boolean
}

/**
 * Static directory backing verifyMembership (config-level, no ctx — mirrors
 * a live WorkOS-style lookup). Keyed by userId. Calls are recorded so tests
 * can assert which organizationId the pipeline passed in.
 */
const VERIFY_DIRECTORY: Record<
	string,
	{ organizationId: string; roleSlug: string } | undefined
> = {
	user_action: { organizationId: 'org_action', roleSlug: 'editor' },
	user_verify: { organizationId: 'org_db_verify', roleSlug: 'editor' },
	// Deliberate mismatch: hook resolves org_db_bad, directory says org_other.
	user_verify_bad: { organizationId: 'org_other', roleSlug: 'editor' },
	user_t1: { organizationId: 'org_t1', roleSlug: 'editor' },
	user_t2: { organizationId: 'org_t2', roleSlug: 'editor' },
	user_happy: { organizationId: 'org_happy', roleSlug: 'editor' },
	user_override: { organizationId: 'org_db', roleSlug: 'editor' },
	user_bypass: { organizationId: 'org_db_bypass', roleSlug: 'editor' },
}

export const verifyCalls: { userId: string; organizationId: string }[] = []

export const auth = createAuthFunctions<GenericDataModel, FixtureRole>({
	query: queryGeneric,
	mutation: mutationGeneric,
	action: actionGeneric,
	internalMutation: internalMutationGeneric,
	internalAction: internalActionGeneric,
	internalQuery: internalQueryGeneric,
	getAuthUser: async (ctx) => {
		// Claim-less identities must still resolve a user: subject is enough.
		const identity = await ctx.auth.getUserIdentity()
		return identity ? { id: identity.subject } : null
	},
	mapRole: (slug) =>
		FIXTURE_ROLES.includes(slug as FixtureRole) ? (slug as FixtureRole) : null,
	adminRoles: ['owner'],
	// Resolves organization + role from the memberships table instead of
	// claims. Actions have no ctx.db, so the hook narrows on its presence.
	resolveOrganization: async ({ ctx, user }) => {
		if (user.id === 'user_boom') throw new Error('membership lookup exploded')
		const membership: MembershipRow | null =
			'db' in ctx
				? await ctx.db
						.query('memberships')
						.withIndex('by_user', (q) => q.eq('userId', user.id))
						.first()
				: await ctx.runQuery(internal.functions.membershipByUser, {
						userId: user.id,
					})
		if (!membership || !membership.active) return null
		return {
			organizationId: membership.organizationId,
			roleSlug: membership.roleSlug,
		}
	},
	verifyMembership: async (input) => {
		verifyCalls.push({ ...input })
		const entry = VERIFY_DIRECTORY[input.userId]
		if (!entry) return null
		return { organizationId: entry.organizationId, roleSlug: entry.roleSlug }
	},
	security: {
		tenancy: { tables: TENANT_TABLES },
	},
})

// A second, hook-less config: proves existing claim-less behavior is unchanged.
export const authNoHook = createAuthFunctions<GenericDataModel, FixtureRole>({
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

// ── seeding / instrumentation (system, trusted) ─────────────────────────────

export const seedMembership = auth.systemMutation({
	args: {
		userId: z.string(),
		organizationId: z.string(),
		roleSlug: z.string(),
		active: z.boolean(),
	},
	handler: async (ctx, args) => {
		await ctx.db.insert('memberships', {
			userId: args.userId,
			organizationId: args.organizationId,
			roleSlug: args.roleSlug,
			active: args.active,
		} as never)
		return null
	},
})

/** Internal lookup for the action branch of the hook (no ctx.db in actions). */
export const membershipByUser = auth.systemQuery({
	args: { userId: z.string() },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query('memberships')
			.withIndex('by_user', (q) => q.eq('userId', args.userId))
			.first()
		if (!row) return null
		const membership = row as never as MembershipRow
		return {
			userId: membership.userId,
			organizationId: membership.organizationId,
			roleSlug: membership.roleSlug,
			active: membership.active,
		}
	},
})

export const recordedVerifyCalls = auth.systemQuery({
	args: { userId: z.string() },
	handler: async (_ctx, args) =>
		verifyCalls.filter((call) => call.userId === args.userId),
})

// ── functions under test (hook-configured auth) ─────────────────────────────

export const whoami = auth.authQuery({
	args: {},
	handler: async (ctx) => ({ ...ctx.actor }),
})

export const whoamiMutation = auth.authMutation({
	args: {},
	handler: async (ctx) => ({ ...ctx.actor }),
})

export const whoamiAction = auth.authAction({
	args: {},
	handler: async (ctx) => ({ ...ctx.actor }),
})

export const createItem = auth.authMutation({
	args: { name: z.string() },
	handler: async (ctx, args) => {
		await ctx.db.insert('items', {
			name: args.name,
			ownerId: ctx.actor.userId,
			tenant: ctx.tenant,
		} as never)
		return null
	},
})

export const listItems = auth.authQuery({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query('items').collect()
		return rows.map((row) => (row as never as { name: string }).name)
	},
})

// ── hook-less regression surface ────────────────────────────────────────────

export const noHookWhoami = authNoHook.authQuery({
	args: {},
	handler: async (ctx) => ({ ...ctx.actor }),
})
