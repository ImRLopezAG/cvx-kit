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

it('injects request-local context additions through existing custom helpers', async () => {
	const custom = zCustomQuery(queryGeneric, {
		args: {},
		input: async (ctx) => ({
			ctx: { actor: (await ctx.auth.getUserIdentity())!.subject },
			args: {},
		}),
	})
	const query = effectZodApiBuilder(custom, {
		context: (ctx) => Effect.succeed({ greeting: () => `hello:${ctx.actor}` }),
	})
	const load = query({
		args: {},
		handler: (ctx) => Effect.succeed(`${ctx.actor}:${ctx.greeting()}`),
	})
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ load }),
	})
	const ref = makeFunctionReference<'query', {}, string>('functions:load')
	expect(
		await Promise.all(
			['alice', 'bob'].map((subject) => t.withIdentity({ subject }).query(ref, {})),
		),
	).toEqual(['alice:hello:alice', 'bob:hello:bob'])
})

it('runs context initialization in the provided scope and releases services on failure', async () => {
	const releases: string[] = []
	const custom = zCustomQuery(queryGeneric, {
		args: {},
		input: () => ({ ctx: { actor: 'trusted' }, args: {} }),
	})
	const query = effectZodApiBuilder(custom, {
		services: (ctx) =>
			Effect.acquireRelease(
				Effect.succeed(Context.make(Request, { actor: ctx.actor, tenant: 'scope' })),
				() =>
					Effect.sync(() => {
						releases.push(ctx.actor)
					}),
			),
		context: () =>
			Effect.gen(function* () {
				return { greeting: (yield* Request).actor }
			}),
	})
	const load = query({ args: {}, handler: (ctx) => Effect.fail(Error(ctx.greeting)) })
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ load }),
	})
	await expect(
		t.query(makeFunctionReference<'query', {}, string>('functions:load'), {}),
	).rejects.toThrow('trusted')
	expect(releases).toEqual(['trusted'])
})

it('rejects attempted replacement of trusted custom context before the handler', async () => {
	let calls = 0
	const custom = zCustomQuery(queryGeneric, {
		args: {},
		input: () => ({ ctx: { actor: 'trusted' }, args: {} }),
	})
	const query = effectZodApiBuilder(custom, {
		// @ts-expect-error Context additions cannot replace existing trusted fields.
		context: () => ({ actor: 'forged' }),
	})
	const load = query({
		args: {},
		handler: () => {
			calls++
			return Effect.succeed('bad')
		},
	})
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ load }),
	})
	await expect(
		t.query(makeFunctionReference<'query', {}, string>('functions:load'), {}),
	).rejects.toThrow('cannot replace actor')
	expect(calls).toBe(0)
})

const customContextlessQuery = zCustomQuery(queryGeneric, {
	args: {},
	input: () => ({ ctx: {}, args: {} }),
})
const missingContextService = effectZodApiBuilder(customContextlessQuery, {
	context: () => Effect.map(Request, (request) => ({ actor: request.actor })),
})

// @ts-expect-error Context initialization requires services that this builder does not provide.
missingContextService({ args: {}, handler: () => Effect.succeed('no') })

const unionCustomQuery = zCustomQuery(queryGeneric, {
	args: {},
	input: () => ({ ctx: { actor: 'trusted' }, args: {} }),
})
effectZodApiBuilder(unionCustomQuery, {
	// @ts-expect-error Every union branch must avoid replacing trusted fields.
	context: (): { actor: string } | { tasks: number } => ({ actor: 'forged' }),
})

it('skips context initialization when authentication denies the request', async () => {
	let initialized = 0
	const custom = zCustomMutation(mutationGeneric, {
		args: {},
		input: async (ctx) => {
			if (!(await ctx.auth.getUserIdentity())) throw Error('UNAUTHORIZED')
			return { ctx: {}, args: {} }
		},
	})
	const mutation = effectZodApiBuilder(custom, {
		context: () => {
			initialized++
			return { feature: true }
		},
	})
	const save = mutation({ args: {}, handler: () => Effect.succeed('ok') })
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ save }),
	})
	await expect(
		t.mutation(makeFunctionReference<'mutation', {}, string>('functions:save'), {}),
	).rejects.toThrow('UNAUTHORIZED')
	expect(initialized).toBe(0)
})

it('projects initialization failures, releases resources, and rolls back initialization writes', async () => {
	let releases = 0
	let handled = false
	const native: MutationBuilder<DataModel, 'public'> = mutationGeneric
	const mutation = effectZodApiBuilder(
		zCustomMutation(native, { args: {}, input: () => ({ ctx: {}, args: {} }) }),
		{
			services: () =>
				Effect.acquireRelease(Effect.succeed(Context.empty()), () =>
					Effect.sync(() => {
						releases++
					}),
				),
			context: (ctx) =>
				Effect.gen(function* () {
					yield* Effect.promise(() =>
						ctx.db.insert('writes', { actor: 'init', tenant: 'init', value: 1 }),
					)
					return yield* Effect.fail('INIT_FAILED')
				}),
			mapError: (error) => Error(`projected:${String(error)}`),
		},
	)
	const save = mutation({
		args: {},
		handler: () => {
			handled = true
			return Effect.succeed('bad')
		},
	})
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ save }),
	})
	await expect(
		t.mutation(makeFunctionReference<'mutation', {}, string>('functions:save'), {}),
	).rejects.toThrow('projected:INIT_FAILED')
	expect(handled).toBe(false)
	expect(releases).toBe(1)
	expect(await t.run((ctx) => ctx.db.query('writes').collect())).toEqual([])
})

it('rejects class instances as additions rather than dropping inherited methods', async () => {
	class Dependencies {
		format() {
			return 'inherited'
		}
	}
	const custom = zCustomQuery(queryGeneric, { args: {}, input: () => ({ ctx: {}, args: {} }) })
	const query = effectZodApiBuilder(custom, {
		// @ts-expect-error Wrap class instances in named record properties.
		context: () => new Dependencies(),
	})
	const load = query({ args: {}, handler: () => Effect.succeed('bad') })
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ load }),
	})
	await expect(
		t.query(makeFunctionReference<'query', {}, string>('functions:load'), {}),
	).rejects.toThrow('must be a plain record')
	const valid = effectZodApiBuilder(custom, { context: () => ({ service: new Dependencies() }) })
	const wrapped = valid({ args: {}, handler: (ctx) => Effect.succeed(ctx.service.format()) })
	const validTest = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ wrapped }),
	})
	expect(
		await validTest.query(makeFunctionReference<'query', {}, string>('functions:wrapped'), {}),
	).toBe('inherited')
})
