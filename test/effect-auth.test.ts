import { Context, Effect } from 'effect'
import { convexTest } from 'convex-test'
import {
	actionGeneric,
	defineSchema,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	makeFunctionReference,
	mutationGeneric,
	queryGeneric,
	type DataModelFromSchemaDefinition,
	type GenericQueryCtx,
	type GenericMutationCtx,
	type GenericActionCtx,
} from 'convex/server'
import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import type { AuthFunctionsConfig, AuthBundle } from '../src/auth'
import { createEffectAuthFunctions } from '../src/effect'

const schema = defineSchema({})
type Model = DataModelFromSchemaDefinition<typeof schema>
type Role = 'owner' | 'viewer'
class Actor extends Context.Service<Actor, { user: string; tenant: string; role: Role }>()(
	'SharedFactoryActor',
) {}
const owner = { subject: 'alice', org_id: 'org-a', role: 'owner' }
const result = z.object({ user: z.string(), tenant: z.string(), role: z.string() })
const families = ['auth', 'role', 'admin', 'system'] as const
const kinds = ['Query', 'Mutation', 'Action'] as const
function harness() {
	let membership: Role | 'wrong-org' | 'throw' | null = 'owner'
	const events: string[] = []
	const config: AuthFunctionsConfig<Model, Role> = {
		query: queryGeneric,
		mutation: mutationGeneric,
		action: actionGeneric,
		internalQuery: internalQueryGeneric,
		internalMutation: internalMutationGeneric,
		internalAction: internalActionGeneric,
		getAuthUser: async (ctx) => {
			const identity = await ctx.auth.getUserIdentity()
			return identity ? { id: identity.subject } : null
		},
		mapRole: (slug) => (slug === 'owner' || slug === 'viewer' ? slug : null),
		adminRoles: ['owner'],
		verifyMembership: async ({ organizationId }) => {
			if (membership === 'throw') throw Error('provider unavailable')
			if (membership === null) return null
			return {
				organizationId: membership === 'wrong-org' ? 'foreign' : organizationId,
				roleSlug: membership === 'wrong-org' ? 'owner' : membership,
			}
		},
	}
	const services = (ctx: AuthBundle<Role>) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				events.push(`open:${ctx.actor.userId}:${ctx.role}`)
				return Context.make(Actor, { user: ctx.actor.userId, tenant: ctx.tenant, role: ctx.role })
			}),
			() =>
				Effect.sync(() => {
					events.push(`close:${ctx.actor.userId}:${ctx.role}`)
				}),
		)
	const context = (ctx: AuthBundle<Role>) => {
		events.push(`bind:${ctx.actor.userId}:${ctx.role}`)
		return { snapshot: () => ({ user: ctx.actor.userId, tenant: ctx.tenant, role: ctx.role }) }
	}
	const systemContext = (
		ctx: GenericQueryCtx<Model> | GenericMutationCtx<Model> | GenericActionCtx<Model>,
	) => {
		expect('actor' in ctx).toBe(false)
		events.push('system')
		return { snapshot: () => ({ user: 'system', tenant: 'system', role: 'system' }) }
	}
	const f = createEffectAuthFunctions(config, {
		query: { services, context, mapError: () => new ConvexError('PROJECTED') },
		mutation: { services, context },
		action: { services, context },
		systemQuery: { context: systemContext },
		systemMutation: { context: systemContext },
		systemAction: { context: systemContext },
	})
	const q = [f.authQuery, f.roleQuery('owner'), f.adminQuery].map((builder) =>
		builder({ args: {}, returns: result, handler: (ctx) => ctx.snapshot() }),
	)
	const m = [f.authMutation, f.roleMutation('owner'), f.adminMutation].map((builder) =>
		builder({ args: {}, returns: result, handler: (ctx) => ctx.snapshot() }),
	)
	const a = [f.authAction, f.roleAction('owner'), f.adminAction].map((builder) =>
		builder({ args: {}, returns: result, handler: (ctx) => ctx.snapshot() }),
	)
	const transformed = f.authQuery({
		args: { value: z.string().transform(Number) },
		returns: z.number().transform((value) => ({ value })),
		handler: (_ctx, args) =>
			Effect.gen(function* () {
				yield* Actor
				return args.value
			}),
	})
	const failed = f.authQuery({ args: {}, handler: () => Effect.fail('SECRET') })
	const collision = createEffectAuthFunctions(config, {
		query: { services, context: () => ({ toString: 'untrusted' }) },
		mutation: {},
		action: {},
		systemQuery: {},
		systemMutation: {},
		systemAction: {},
	}).authQuery({
		args: {},
		handler: () => {
			events.push('collision-handler')
			return null
		},
	})
	const all = {
		collision,
		systemQuery: f.systemQuery({ args: {}, returns: result, handler: (ctx) => ctx.snapshot() }),
		systemMutation: f.systemMutation({
			args: {},
			returns: result,
			handler: (ctx) => ctx.snapshot(),
		}),
		systemAction: f.systemAction({ args: {}, returns: result, handler: (ctx) => ctx.snapshot() }),
		transformed,
		failed,
		...Object.fromEntries(
			families.slice(0, 3).flatMap((family, i) => [
				[`${family}Query`, q[i]],
				[`${family}Mutation`, m[i]],
				[`${family}Action`, a[i]],
			]),
		),
	}
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => all,
	})
	async function invoke(
		family: (typeof families)[number],
		kind: (typeof kinds)[number],
		identity?: typeof owner,
	) {
		const caller = identity ? t.withIdentity(identity) : t
		const name = `functions:${family}${kind}`
		if (kind === 'Query')
			return caller.query(makeFunctionReference<'query', {}, z.output<typeof result>>(name), {})
		if (kind === 'Mutation')
			return caller.mutation(
				makeFunctionReference<'mutation', {}, z.output<typeof result>>(name),
				{},
			)
		return caller.action(makeFunctionReference<'action', {}, z.output<typeof result>>(name), {})
	}
	return {
		t,
		events,
		invoke,
		membership: (value: typeof membership) => {
			membership = value
		},
	}
}

describe('shared post-auth Effect factory', () => {
	it('provides all twelve constructors with explicit system contexts', async () => {
		const h = harness()
		for (const kind of kinds)
			for (const family of families) {
				expect(await h.invoke(family, kind, family === 'system' ? undefined : owner)).toEqual(
					family === 'system'
						? { user: 'system', tenant: 'system', role: 'system' }
						: { user: 'alice', tenant: 'org-a', role: 'owner' },
				)
			}
		expect(h.events.filter((event) => event.startsWith('open:'))).toHaveLength(9)
		expect(h.events.filter((event) => event.startsWith('close:'))).toHaveLength(9)
	})
	it('skips providers and binding for unauthenticated and role-denied callers', async () => {
		const h = harness()
		for (const kind of kinds) {
			for (const family of ['auth', 'role', 'admin'] as const)
				await expect(h.invoke(family, kind)).rejects.toThrow()
			for (const family of ['role', 'admin'] as const) {
				h.membership('viewer')
				await expect(h.invoke(family, kind, { ...owner, role: 'viewer' })).rejects.toThrow()
			}
		}
		expect(h.events).toEqual([])
	})
	it('binds the live action role and fails closed before binding on membership failures', async () => {
		const h = harness()
		h.membership('viewer')
		expect(await h.invoke('auth', 'Action', owner)).toEqual({
			user: 'alice',
			tenant: 'org-a',
			role: 'viewer',
		})
		h.events.length = 0
		await expect(h.invoke('role', 'Action', owner)).rejects.toThrow()
		await expect(h.invoke('admin', 'Action', owner)).rejects.toThrow()
		for (const membership of [null, 'wrong-org', 'throw'] as const) {
			h.membership(membership)
			await expect(h.invoke('auth', 'Action', owner)).rejects.toThrow()
		}
		expect(h.events).toEqual([])
	})
	it('keeps interleaved identities and service scopes local to each invocation', async () => {
		const h = harness()
		const values = await Promise.all([
			h.invoke('auth', 'Query', owner),
			h.invoke('auth', 'Query', { subject: 'bob', org_id: 'org-b', role: 'viewer' }),
		])
		expect(values).toEqual([
			{ user: 'alice', tenant: 'org-a', role: 'owner' },
			{ user: 'bob', tenant: 'org-b', role: 'viewer' },
		])
		expect(h.events.filter((event) => event.startsWith('close:')).sort()).toEqual([
			'close:alice:owner',
			'close:bob:viewer',
		])
	})
	it('retains parsed arguments, result transforms, service requirements, and projected failures', async () => {
		const h = harness()
		const t = h.t.withIdentity(owner)
		expect(
			await t.query(
				makeFunctionReference<'query', { value: string }, { value: number }>(
					'functions:transformed',
				),
				{ value: '42' },
			),
		).toEqual({ value: 42 })
		await expect(t.query(makeFunctionReference<'query'>('functions:failed'), {})).rejects.toThrow(
			'PROJECTED',
		)
		expect(h.events.filter((event) => event.startsWith('close:'))).toHaveLength(2)
	})
	it('rejects inherited native context collisions before the handler and closes the scope', async () => {
		const h = harness()
		await expect(
			h.t.withIdentity(owner).query(makeFunctionReference<'query'>('functions:collision'), {}),
		).rejects.toThrow(/toString/)
		expect(h.events).toEqual(['open:alice:owner', 'close:alice:owner'])
	})
})
