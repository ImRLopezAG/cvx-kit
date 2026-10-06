import { Context, Effect } from 'effect'
import { convexTest } from 'convex-test'
import {
	defineSchema,
	defineTable,
	mutationGeneric,
	queryGeneric,
	makeFunctionReference,
	type MutationBuilder,
	type DataModelFromSchemaDefinition,
} from 'convex/server'
import { v } from 'convex/values'
import { zCustomMutation, zCustomQuery } from 'convex-helpers/server/zod4'
import { expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { effectZodApiBuilder } from '../src/effect'

const schema = defineSchema({
	writes: defineTable({ actor: v.string(), tenant: v.string(), value: v.number() }),
})
type DataModel = DataModelFromSchemaDefinition<typeof schema>
class Request extends Context.Service<Request, { actor: string; tenant: string }>()(
	'CustomApiRequest',
) {}

it('provides services after real customization and parsing, then validates the Effect result', async () => {
	const events: string[] = []
	const native: MutationBuilder<DataModel, 'public'> = mutationGeneric
	const custom = zCustomMutation(native, {
		args: { tenant: v.string() },
		input: async (ctx, args, options: { permission: string }) => {
			const identity = await ctx.auth.getUserIdentity()
			if (!identity) throw new Error('UNAUTHORIZED')
			events.push(`auth:${identity.subject}:${options.permission}`)
			return {
				ctx: { actor: identity.subject, tenant: args.tenant },
				args: { made: 7 },
				onSuccess: () => {
					events.push('custom-success')
				},
			}
		},
	})
	const mutation = effectZodApiBuilder(custom, {
		services: (ctx) => {
			events.push(`services:${ctx.actor}:${ctx.tenant}`)
			return Context.make(Request, { actor: ctx.actor, tenant: ctx.tenant })
		},
	})
	const save = mutation({
		args: {
			actor: z.string(),
			made: z.number(),
			value: z.string().transform((value) => {
				events.push('parse')
				return value.length
			}),
		},
		returns: z.number().transform((value) => {
			events.push('result')
			return String(value)
		}),
		permission: 'write',
		skipConvexValidation: true,
		handler: (ctx, args) =>
			Effect.gen(function* () {
				const request = yield* Request
				events.push(`handler:${args.made}:${args.value}`)
				yield* Effect.promise(() =>
					ctx.db.insert('writes', {
						actor: request.actor,
						tenant: request.tenant,
						value: args.value + args.made,
					}),
				)
				return args.value + args.made
			}),
	})
	const modules = {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ save }),
	}
	const t = convexTest(schema, modules).withIdentity({ subject: 'trusted-actor' })
	const ref = makeFunctionReference<
		'mutation',
		{ tenant: string; actor: string; made: number; value: string },
		string
	>('functions:save')
	expect(
		await t.mutation(ref, { tenant: 'tenant-a', actor: 'forged', made: 900, value: 'four' }),
	).toBe('11')
	expect(events).toEqual([
		'auth:trusted-actor:write',
		'parse',
		'services:trusted-actor:tenant-a',
		'handler:7:4',
		'result',
		'custom-success',
	])
	const rows = await t.run((ctx) => ctx.db.query('writes').collect())
	expect(rows).toHaveLength(1)
	expect(rows[0]).toMatchObject({ actor: 'trusted-actor', tenant: 'tenant-a', value: 11 })
})

it('does not construct services for denied customization or invalid parsed input', async () => {
	let providers = 0
	const wrapped = effectZodApiBuilder(
		zCustomMutation(mutationGeneric, {
			args: {},
			input: async (ctx) => {
				if (!(await ctx.auth.getUserIdentity())) throw Error('UNAUTHORIZED')
				return { ctx: {}, args: {} }
			},
		}),
		{
			services: () => {
				providers++
				return Context.empty()
			},
		},
	)
	const save = wrapped({ args: { value: z.string().min(3) }, handler: () => Effect.succeed('ok') })
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ save }),
	})
	const ref = makeFunctionReference<'mutation', { value: string }, string>('functions:save')
	await expect(t.mutation(ref, { value: 'okay' })).rejects.toThrow('UNAUTHORIZED')
	await expect(t.withIdentity({ subject: 'actor' }).mutation(ref, { value: 'x' })).rejects.toThrow()
	expect(providers).toBe(0)
})

it('supports bare callable custom queries and Promise-provided services', async () => {
	const query = effectZodApiBuilder(
		zCustomQuery(queryGeneric, {
			args: {},
			input: () => ({ ctx: { actor: 'server' }, args: { made: 2 } }),
		}),
		{ services: async (ctx) => Context.make(Request, { actor: ctx.actor, tenant: 'query' }) },
	)
	const load = query((_ctx, args) =>
		Effect.gen(function* () {
			return `${(yield* Request).actor}:${args.made}`
		}),
	)
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ load }),
	})
	expect(
		await t.query(makeFunctionReference<'query', Record<string, never>, string>('functions:load')),
	).toBe('server:2')
})

it('rolls back registered mutation writes when custom result parsing rejects', async () => {
	let successCallbacks = 0
	let writeCompleted = false
	const native: MutationBuilder<DataModel, 'public'> = mutationGeneric
	const mutation = effectZodApiBuilder(
		zCustomMutation(native, {
			args: {},
			input: () => ({
				ctx: {},
				args: {},
				onSuccess: () => {
					successCallbacks++
				},
			}),
		}),
		{ services: () => Context.empty() },
	)
	const save = mutation({
		args: {},
		returns: z.number().positive(),
		handler: (ctx) =>
			Effect.gen(function* () {
				yield* Effect.promise(() =>
					ctx.db.insert('writes', { actor: 'fixture', tenant: 'fixture', value: -1 }),
				)
				writeCompleted = true
				return -1
			}),
	})
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ save }),
	})
	await expect(
		t.mutation(makeFunctionReference<'mutation', {}, number>('functions:save'), {}),
	).rejects.toThrow('Too small')
	expect(writeCompleted).toBe(true)
	expect(successCallbacks).toBe(0)
	expect(await t.run((ctx) => ctx.db.query('writes').collect())).toEqual([])
})
