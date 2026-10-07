import { createEffectFoundation } from 'cvx-kit/effect'
import { defineErrorContract } from 'cvx-kit/errors'
import { Context, Effect } from 'effect'
import { z } from 'zod'
import type { MutationCtx, QueryCtx } from './_generated/server'

export class Reader extends Context.Service<
	Reader,
	{ read: (key: string) => Promise<string[]>; events: string[] }
>()('FixtureReader') {}

export class FixtureFailure {
	readonly _tag = 'FixtureFailure'
	constructor(readonly stage: string) {}
}

export const declaredErrors = defineErrorContract({
	DENIED: { message: 'Operation denied', details: { key: z.string() } },
})

const observability = {
	enabled: false,
	classifyError: () => ({ outcome: 'failed' as const, errorCode: 'FIXTURE' }),
}
const queryFoundation = createEffectFoundation({ observability, writeAudit: () => undefined })
const primitiveQueries = queryFoundation.Query({
	context: (ctx: QueryCtx) => ctx,
	operations: ({ query }) => ({
		ordinary: query({
			input: z.object({ key: z.string() }),
			result: z.number(),
			handler: async ({ key }, ctx) =>
				(
					await ctx.db
						.query('writes')
						.withIndex('by_key', (q) => q.eq('key', key))
						.take(20)
				).length,
		}),
		named: query({
			input: z.object({ key: z.string() }),
			result: z.number(),
			handler: Effect.fn('fixture.named')(function* ({ key }: { key: string }) {
				const reader = yield* Reader
				return (yield* Effect.promise(() => reader.read(key))).length
			}),
		}),
	}),
})
export const queries = queryFoundation.Query({
	context: (ctx: QueryCtx) => ctx,
	operations: ({ query }) => ({
		composed: query({
			input: z.object({ key: z.string() }),
			result: z.object({ count: z.number(), events: z.array(z.string()) }),
			handler: (input, ctx) =>
				Effect.gen(function* () {
					const reader = yield* Reader
					const ordinary = yield* primitiveQueries.exec('ordinary', input, ctx)
					const named = yield* primitiveQueries.exec('named', input, ctx)
					reader.events.push('handler')
					return { count: ordinary + named, events: reader.events }
				}).pipe(Effect.withSpan('fixture.query')),
		}),
	}),
})

export type CommandHost = {
	ctx: MutationCtx
	key: string
	mode: 'success' | 'domain' | 'audit' | 'completion'
}
const commandFoundation = createEffectFoundation({
	observability,
	checkPermission: (host: CommandHost) => {
		if (!host.key) throw new Error('fixture key required')
	},
	writeAudit: (host: CommandHost) =>
		Effect.gen(function* () {
			yield* Effect.promise(() => host.ctx.db.insert('writes', { key: host.key, stage: 'audit' }))
			if (host.mode === 'audit') return yield* Effect.fail(new FixtureFailure('audit'))
		}),
})
export const commands = commandFoundation.Command({
	context: (host: CommandHost) => host,
	operations: ({ command }) => ({
		save: command({
			input: z.object({}),
			result: z.literal('saved'),
			classification: 'business',
			permission: 'fixture:write',
			prepare: (host) => ({
				kind: 'execute' as const,
				complete: () =>
					Effect.gen(function* () {
						yield* Effect.promise(() =>
							host.ctx.db.insert('writes', { key: host.key, stage: 'completion' }),
						)
						if (host.mode === 'completion')
							return yield* Effect.fail(new FixtureFailure('completion'))
					}),
			}),
			handler: (_input, host) =>
				Effect.gen(function* () {
					yield* Effect.promise(() =>
						host.ctx.db.insert('writes', { key: host.key, stage: 'domain' }),
					)
					if (host.mode === 'domain') return yield* Effect.fail(new FixtureFailure('domain'))
					return 'saved' as const
				}),
			audit: (_resolution, host) => ({
				operation: 'save',
				actorId: 'fixture-server',
				aggregate: { type: 'fixture', id: host.key },
			}),
		}),
	}),
})
