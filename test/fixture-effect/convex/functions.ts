import { effectApiBuilder, effectZodApiBuilder } from 'cvx-kit/effect'
import { Context, Effect } from 'effect'
import { ConvexError, v } from 'convex/values'
import { zCustomMutation } from 'convex-helpers/server/zod4'
import { z } from 'zod'
import { internalMutation, internalQuery, mutation, query } from './_generated/server'
import { commands, FixtureFailure, queries, Reader } from './domain'

const scopedQuery = effectApiBuilder(query, {
	services: (ctx) =>
		Effect.acquireRelease(
			Effect.sync(() =>
				Context.make(Reader, {
					read: async (key) =>
						(
							await ctx.db
								.query('writes')
								.withIndex('by_key', (q) => q.eq('key', key))
								.take(20)
						).map((row) => row.stage),
					events: ['acquire'],
				}),
			),
			(context) =>
				Effect.promise(async () => {
					await ctx.db
						.query('writes')
						.withIndex('by_key', (q) => q.eq('key', 'release-probe'))
						.take(1)
					Context.get(context, Reader).events.push('release')
				}),
		),
})
export const composed = scopedQuery({
	args: { key: v.string() },
	returns: v.object({ count: v.number(), events: v.array(v.string()) }),
	handler: (ctx, args) =>
		Effect.gen(function* () {
			const result = yield* queries.exec('composed', args, ctx)
			// Domain validation clones arrays; return the provider's invocation-local array.
			return { count: result.count, events: (yield* Reader).events }
		}),
})

const mappedMutation = effectApiBuilder(mutation, {
	services: () => Context.empty(),
	mapError: (error) =>
		new ConvexError(
			error instanceof FixtureFailure ? `FIXTURE_${error.stage}` : 'FIXTURE_EXPECTED',
		),
})
const mode = v.union(
	v.literal('success'),
	v.literal('domain'),
	v.literal('audit'),
	v.literal('completion'),
)
export const save = mappedMutation({
	args: { key: v.string(), mode },
	returns: v.literal('saved'),
	handler: (ctx, args) => commands.exec('save', {}, { ctx, ...args }),
})
const mappedInternalMutation = effectApiBuilder(internalMutation, {
	services: () => Context.empty(),
	mapError: () => new ConvexError('FIXTURE_EXPECTED'),
})
export const internalSave = mappedInternalMutation({
	args: { key: v.string(), mode },
	returns: v.literal('saved'),
	handler: (ctx, args) => commands.exec('save', {}, { ctx, ...args }),
})

const cleanupMutation = effectApiBuilder(internalMutation, {
	services: (ctx) =>
		Effect.acquireRelease(Effect.succeed(Context.empty()), () =>
			Effect.promise(async () => {
				await ctx.db.insert('writes', { key: 'cleanup', stage: 'release' })
			}).pipe(Effect.flatMap(() => Effect.die(new Error('FIXTURE_CLEANUP')))),
		),
	mapError: () => new ConvexError('PROJECTION_MUST_NOT_RUN'),
})
export const cleanupFailure = cleanupMutation({
	args: { composite: v.boolean() },
	returns: v.literal('saved'),
	handler: (ctx, args) =>
		Effect.gen(function* () {
			yield* Effect.promise(() => ctx.db.insert('writes', { key: 'cleanup', stage: 'domain' }))
			if (args.composite) return yield* Effect.fail(new FixtureFailure('domain'))
			return 'saved' as const
		}),
})
export const read = internalQuery({
	args: { key: v.string() },
	returns: v.array(v.string()),
	handler: async (ctx, { key }) =>
		(
			await ctx.db
				.query('writes')
				.withIndex('by_key', (q) => q.eq('key', key))
				.take(20)
		).map((row) => row.stage),
})

// Deliberately wrong output tests native return rejection after a write.
const validatedMutation = effectApiBuilder(internalMutation, { services: () => Context.empty() })
export const invalidReturn = validatedMutation({
	args: { key: v.string() },
	returns: v.literal('saved'),
	handler: (ctx, args) =>
		Effect.gen(function* () {
			yield* Effect.promise(() =>
				ctx.db.insert('writes', { key: args.key, stage: 'invalid-return' }),
			)
			// SAFETY: Deliberate invalid runtime output tests Convex's native return contract.
			return 'invalid' as 'saved'
		}),
})
const customMutation = effectZodApiBuilder(
	zCustomMutation(internalMutation, {
		args: {},
		input: () => ({ ctx: { actor: 'trusted-server' }, args: {} }),
	}),
	{ services: () => Context.empty() },
)
export const invalidCustomReturn = customMutation({
	args: { key: z.string() },
	returns: z
		.string()
		.transform((value) => value.length)
		.refine((length) => length > 100, 'FIXTURE_CUSTOM_RETURN'),
	skipConvexValidation: true,
	handler: (ctx, args) =>
		Effect.gen(function* () {
			yield* Effect.promise(() => ctx.db.insert('writes', { key: args.key, stage: ctx.actor }))
			return 'invalid'
		}),
})
