import { effectApiBuilder } from 'cvx-kit/effect'
import { Context, Effect } from 'effect'
import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import { action } from './_generated/server'
import { declaredErrors } from './domain'

class HttpFixture extends Context.Service<HttpFixture, { fetch: () => Promise<string> }>()(
	'FixtureHttp',
) {}
const fixtureAction = effectApiBuilder(action, {
	services: () =>
		Context.make(HttpFixture, {
			fetch: async () => {
				const site = process.env.CONVEX_SITE_URL
				if (!site || !new URL(site).hostname.match(/^(127\.0\.0\.1|localhost)$/))
					throw new Error('Fixture requires local HTTP')
				const response = await fetch(`${site}/effect-fixture`)
				if (!response.ok) throw new Error('Fixture HTTP failed')
				return response.text()
			},
		}),
})
export const orchestrate = fixtureAction({
	args: { key: v.string() },
	returns: v.object({ body: v.string(), stages: v.array(v.string()), rejected: v.boolean() }),
	handler: (
		ctx,
		{ key },
	): Effect.Effect<{ body: string; stages: string[]; rejected: boolean }, never, HttpFixture> =>
		Effect.gen(function* () {
			const http = yield* HttpFixture
			const body = yield* Effect.promise(http.fetch)
			yield* Effect.promise(() =>
				ctx.runMutation(internal.functions.internalSave, { key, mode: 'success' }),
			)
			const rejected = yield* Effect.promise(async () => {
				try {
					await ctx.runMutation(internal.functions.internalSave, { key, mode: 'completion' })
					return false
				} catch (error) {
					if (error instanceof ConvexError && error.data === 'FIXTURE_EXPECTED') return true
					if (error instanceof Error && error.message.includes('FIXTURE_EXPECTED')) return true
					throw error
				}
			})
			const stages = yield* Effect.promise(() => ctx.runQuery(internal.functions.read, { key }))
			return { body, stages, rejected }
		}).pipe(Effect.withSpan('fixture.action')),
})

export const declaredFailureRoundTrip = action({
	args: { key: v.string(), composite: v.boolean() },
	returns: v.union(
		v.object({ kind: v.literal('declared'), code: v.literal('DENIED'), key: v.string() }),
		v.object({ kind: v.literal('unknown') }),
	),
	handler: async (ctx, args) => {
		try {
			await ctx.runMutation(internal.functions.declaredFailure, args)
			throw new Error('Expected declared mutation rejection')
		} catch (error) {
			if (!(error instanceof ConvexError)) throw error
			const decoded = declaredErrors.decode(error.data)
			if (decoded._tag === 'UnknownFailure') return { kind: 'unknown' as const }
			return { kind: 'declared' as const, code: decoded.code, key: decoded.details.key }
		}
	},
})
