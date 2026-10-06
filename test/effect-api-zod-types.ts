import { Context, Effect } from 'effect'
import { z } from 'zod'
import { v } from 'convex/values'
import {
	queryGeneric,
	mutationGeneric,
	internalMutationGeneric,
	actionGeneric,
	type ApiFromModules,
} from 'convex/server'
import { zCustomQuery, zCustomMutation, zCustomAction } from 'convex-helpers/server/zod4'
import { effectZodApiBuilder } from '../src/effect'

class Actor extends Context.Service<Actor, { id: string }>()('ApiZodActor') {}
class Missing extends Context.Service<Missing, { value: string }>()('ApiZodMissing') {}
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
const custom = zCustomMutation(internalMutationGeneric, {
	args: { session: v.string() },
	input: (_ctx, args, extra: { permission: 'read' | 'write' }) => ({
		ctx: { actor: { id: args.session }, permission: extra.permission },
		args: { made: 42 },
	}),
})
const mutation = effectZodApiBuilder(custom, {
	services: (ctx) => {
		ctx.actor.id.toUpperCase()
		ctx.permission satisfies 'read' | 'write'
		return Context.make(Actor, ctx.actor)
	},
})
const transformed = mutation({
	args: z.object({ amount: z.string().transform((value) => value.length) }),
	returns: z.number().transform((value) => String(value)),
	permission: 'write',
	skipConvexValidation: true,
	handler: (ctx, args) => {
		ctx.actor.id.toUpperCase()
		args.made.toFixed()
		args.amount.toFixed()
		return Effect.gen(function* () {
			yield* Actor
			return args.amount
		})
	},
})
type Ref = ApiFromModules<{
	functions: { transformed: typeof transformed }
}>['functions']['transformed']
type Raw = Assert<Equal<Ref['_args'], { amount: string; session: string }>>
type Final = Assert<Equal<Ref['_returnType'], string>>
type Kind = Assert<Equal<Ref['_type'], 'mutation'>>
type Visibility = Assert<Equal<Ref['_visibility'], 'internal'>>
const checks: [Raw, Final, Kind, Visibility] = [true, true, true, true]
void checks
// @ts-expect-error required extra customization option retained
mutation({ args: {}, handler: () => 1 })
mutation({
	args: {},
	permission: 'read',
	returns: z.number().transform(String),
	// @ts-expect-error result before transform must be number
	handler: () => Effect.succeed('bad'),
})
// @ts-expect-error missing services rejected even without a returns validator
mutation({ args: {}, permission: 'read', handler: () => Missing })
// @ts-expect-error missing services rejected with returns validator
mutation({
	args: {},
	permission: 'read',
	returns: z.string(),
	handler: () => Missing.pipe(Effect.map((value) => value.value)),
})
// @ts-expect-error caller cannot pass a made arg or parsed number in raw transport input
const invalidRaw: Ref['_args'] = { session: 'session', amount: 1, made: 42 }
void invalidRaw
const query = effectZodApiBuilder(
	zCustomQuery(queryGeneric, {
		args: {},
		input: () => ({ ctx: { actor: { id: 'trusted' } }, args: {} }),
	}),
	{ services: (ctx) => Context.make(Actor, ctx.actor) },
)
const plain = query({
	args: { count: z.number() },
	handler: (ctx, args) => {
		// @ts-expect-error native query context remains reader-only
		void ctx.db.insert('table', {})
		return Promise.resolve(args.count)
	},
})
type PlainRef = ApiFromModules<{ functions: { plain: typeof plain } }>['functions']['plain']
const plainCheck: Assert<Equal<PlainRef['_returnType'], number>> = true
void plainCheck
const bare = query((_ctx, args) => Effect.succeed(args.count))
void bare
const action = effectZodApiBuilder(
	zCustomAction(actionGeneric, {
		args: {},
		input: () => ({ ctx: {}, args: {} }),
	}),
	{ services: () => Context.empty() },
)
const actionFn = action({
	args: {},
	returns: { ok: z.boolean() },
	handler: (ctx) => {
		void ctx.runMutation
		return Effect.succeed({ ok: true })
	},
})
const publicMutation = effectZodApiBuilder(
	zCustomMutation(mutationGeneric, {
		args: {},
		input: () => ({ ctx: {}, args: {} }),
	}),
	{ services: () => Context.empty() },
)
const publicFn = publicMutation(() => Effect.succeed(1))
type PublicRef = ApiFromModules<{
	functions: { publicFn: typeof publicFn }
}>['functions']['publicFn']
const publicCheck: Assert<Equal<PublicRef['_visibility'], 'public'>> = true
void publicCheck
void actionFn
void effectZodApiBuilder(custom, {
	// @ts-expect-error providers may require only adapter-owned Scope
	services: () => Missing.pipe(Effect.map(() => Context.empty())),
})
// @ts-expect-error Promise cannot hide an unprovided Effect requirement
mutation({
	args: {},
	permission: 'read',
	handler: async () => Missing.pipe(Effect.map((value) => value.value)),
})
const named = query({
	args: { value: z.number() },
	returns: z.number(),
	handler: Effect.fn('custom-query')(function* (_ctx, args: { value: number }) {
		yield* Actor
		return args.value
	}),
})
void named
