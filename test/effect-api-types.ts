import { Context, Effect, Schema } from 'effect'
import {
	actionGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	type FunctionReference,
	type ApiFromModules,
	type GenericDataModel,
	type GenericQueryCtx,
} from 'convex/server'
import { v } from 'convex/values'
import { effectApiBuilder, effectSchema } from '../src/effect'
import { defineErrorContract } from '../src/errors'
class Request extends Context.Service<Request, { value: number }>()('ApiTypeRequest') {}
class Missing extends Context.Service<Missing, { value: number }>()('ApiTypeMissing') {}
// @ts-expect-error Explicit service capabilities require a provider callback.
effectApiBuilder<GenericDataModel, 'public', Context.Context<Request>>(queryGeneric, {})
// @ts-expect-error Explicit added fields require a context initializer.
effectApiBuilder<GenericDataModel, 'public', Context.Context<never>, { extra: number }>(queryGeneric, {})
declare const optionalServices: ((ctx: GenericQueryCtx<GenericDataModel>) => Context.Context<Request>) | undefined
// @ts-expect-error A potentially missing callback cannot guarantee services.
effectApiBuilder(queryGeneric, { services: optionalServices })
declare const optionalContext: ((ctx: GenericQueryCtx<GenericDataModel>) => { extra: number }) | undefined
// @ts-expect-error A potentially missing callback cannot guarantee added fields.
effectApiBuilder(queryGeneric, { context: optionalContext })
const query = effectApiBuilder(queryGeneric, {
	services: (ctx) => {
		// @ts-expect-error Native query providers cannot write.
		ctx.db.insert('things', {})
		return Context.make(Request, { value: 1 })
	},
})
const registered = query({
	args: { name: v.string() },
	returns: v.number(),
	handler: (_ctx, args) => Effect.map(Request, ({ value }) => value + args.name.length),
})
const inferred = query({
	args: { name: v.string() },
	handler: (_ctx, args) => Effect.succeed(args.name.length),
})
const callable = query((_ctx, args: { name: string }) => Effect.succeed(args.name.length))
// @ts-expect-error Missing service rejected with no return validator.
query({ handler: () => Effect.map(Missing, ({ value }) => value) })
// @ts-expect-error Missing service rejected with return validator.
query({ returns: v.number(), handler: () => Effect.map(Missing, ({ value }) => value) })
// @ts-expect-error Output must match native returns validator.
query({ returns: v.number(), handler: () => Effect.succeed('bad') })
// @ts-expect-error A provider cannot require another unresolved service.
effectApiBuilder(queryGeneric, { services: () => Effect.map(Missing, () => Context.empty()) })
const mutation = effectApiBuilder(mutationGeneric, {
	services: (ctx) => {
		void ctx.db.insert
		return Context.empty()
	},
})
const action = effectApiBuilder(actionGeneric, {
	services: (ctx) => {
		void ctx.runMutation
		return Context.empty()
	},
})
const internal = effectApiBuilder(internalQueryGeneric, { services: () => Context.empty() })({
	handler: () => 1,
})
type Api = ApiFromModules<{
	functions: {
		registered: typeof registered
		inferred: typeof inferred
		callable: typeof callable
		internal: typeof internal
	}
}>
declare const references: Api['functions']
const reference: FunctionReference<'query', 'public', { name: string }, number> =
	references.registered
const inferredReference: FunctionReference<'query', 'public', { name: string }, number> =
	references.inferred
const callableReference: FunctionReference<'query', 'public', { name: string }, number> =
	references.callable
const internalReference: FunctionReference<'query', 'internal', {}, number> = references.internal
void [mutation, action, reference, inferredReference, callableReference, internalReference]

declare const serviceCodec: Schema.Codec<string, number, Request, Missing>
const codec = effectSchema(serviceCodec)
query({ returns: v.string(), handler: () => codec.decode(1) })
// @ts-expect-error Encoding services stay required even when decoding services are provided.
query({ returns: v.number(), handler: () => codec.decode(1).pipe(Effect.flatMap(codec.encode)) })
const errors = defineErrorContract({ DENIED: { message: 'Denied', details: {} } })
// @ts-expect-error A checked error contract and legacy mapper cannot compete at the same boundary.
effectApiBuilder(queryGeneric, {
	services: () => Context.empty(),
	errors,
	mapError: () => new Error('legacy'),
})
