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
import { Foundation } from '../../src/components/foundation/client'
import { createCrudCommands } from '../../src/crud'
import { createTriggers, tenantOwnership, timestamps } from '../../src/triggers'
import { recordWebhookEvent } from '../../src/webhooks'
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
		// may modify project rows, whatever the handler tries. The audit sink
		// is insert-only for everyone (reads stay denied).
		rules: (bundle) => ({
			projects: {
				modify: async () => bundle.role === 'owner',
			},
			audits: {
				insert: async () => true,
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

export const listPage = auth.authQuery({
	args: { numItems: z.number(), cursor: z.string().nullable() },
	handler: (ctx, args) =>
		ctx
			.include(ctx.db.query('projects'))
			.matching('by_tenant', (ix) => ix.eq('tenant', ctx.tenant))
			.paginate({ numItems: args.numItems, cursor: args.cursor }, (rows) =>
				rows.map((row) => projects.toPublicDto(row as never)),
			),
})

/** Full-scan pagination on purpose: RLS must filter foreign rows mid-page. */
export const listPageUnscoped = auth.authQuery({
	args: { numItems: z.number(), cursor: z.string().nullable() },
	handler: (ctx, args) =>
		ctx
			.include(ctx.db.query('projects'))
			.paginate({ numItems: args.numItems, cursor: args.cursor }, (rows) =>
				rows.map((row) => projects.toPublicDto(row as never)),
			),
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

// ── CRUD factory under the real pipeline ────────────────────────────────────
type CrudCtx = {
	db: {
		insert: (table: never, value: never) => Promise<unknown>
		patch: (id: never, value: never) => Promise<unknown>
	}
	actor: { userId: string }
	tenant: string
}

const { Command } = new Foundation(
	{ functions: { status: 'status' } },
	{
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'UNEXPECTED' }),
			writeAudit: async (context, entry) => {
				await (context as unknown as CrudCtx).db.insert(
					'audits' as never,
					{
						operation: entry.operation,
						actorId: entry.actorId,
						aggregateType: entry.aggregate.type,
						aggregateId: entry.aggregate.id,
					} as never,
				)
			},
		},
	},
)

const projectCrud = createCrudCommands<CrudCtx>({
	Command,
	table: projects,
	aggregateType: 'project',
	actor: (ctx) => ctx.actor.userId,
	enrich: (ctx) => ({ tenant: ctx.tenant, ownerId: ctx.actor.userId }),
})

export const crudCreate = auth.authMutation({
	args: { name: z.string() },
	handler: async (ctx, args) => {
		const result = await projectCrud.executeCreate(ctx as never, args as never)
		return (result as { id: unknown }).id
	},
})

export const crudUpdate = auth.authMutation({
	args: { id: z.string(), name: z.string() },
	handler: async (ctx, args) => {
		await projectCrud.executeUpdate(
			ctx as never,
			{ id: args.id, data: { name: args.name } } as never,
		)
		return null
	},
})

export const crudArchive = auth.authMutation({
	args: { id: z.string() },
	handler: async (ctx, args) => {
		await projectCrud.executeArchive(ctx as never, { id: args.id } as never)
		return null
	},
})

export const auditCount = auth.systemQuery({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query('audits').collect()
		return rows.map((row) => (row as never as { operation: string }).operation)
	},
})

export const getProject = auth.systemQuery({
	args: { id: z.string() },
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.id as never)
		return row as never
	},
})

export const receiveEvent = auth.systemMutation({
	args: { eventKey: z.string(), payload: z.string(), source: z.string() },
	handler: async (ctx, args) => {
		const dedup = await recordWebhookEvent(ctx as never, {
			key: args.eventKey,
			source: args.source,
		})
		if (dedup.duplicate) return { duplicate: true, applied: false }
		await ctx.db.insert('globals', { note: `event:${args.eventKey}` } as never)
		return { duplicate: false, applied: true }
	},
})
