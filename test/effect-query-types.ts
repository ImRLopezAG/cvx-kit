import { Context, Effect } from 'effect'
import { z } from 'zod'
import { createEffectQuery, bindEffectQuery } from '../src/modules/effect/query'
import { effectOperationFactory } from '../src/modules/effect/operation'
import { Observability } from '../src/components/foundation/modules/observability/observability'

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value
class Reader extends Context.Service<Reader, { count: number }>()('Reader') {}
class Request extends Context.Service<Request, { actorId: string }>()('Request') {}
class Policy extends Context.Service<Policy, { permitted: boolean }>()('Policy') {}
class DefaultPolicy extends Context.Service<DefaultPolicy, { ready: boolean }>()('DefaultPolicy') {}
class ReadFailure {
	readonly _tag = 'ReadFailure'
}
class RequestFailure {
	readonly _tag = 'RequestFailure'
}
class PolicyFailure {
	readonly _tag = 'PolicyFailure'
}
class DefaultFailure {
	readonly _tag = 'DefaultFailure'
}

const queries = createEffectQuery({
	context: (host: { invocation: string }) =>
		Effect.gen(function* () {
			const request = yield* Request
			if (!host.invocation) return yield* Effect.fail(new RequestFailure())
			return { actorId: request.actorId }
		}),
	checkPermission: (_host, _permission) =>
		Effect.gen(function* () {
			const policy = yield* Policy
			if (!policy.permitted) return yield* Effect.fail(new PolicyFailure())
		}),
	defaults: {
		guard: (_context) =>
			Effect.gen(function* () {
				const policy = yield* DefaultPolicy
				if (!policy.ready) return yield* Effect.fail(new DefaultFailure())
			}),
	},
	operations: ({ query }) => ({
		read: query({
			input: z.string().transform((value) => value.length),
			result: z.number().transform(String),
			permission: 'read',
			handler: (input, context) =>
				Effect.gen(function* () {
					input.toFixed()
					context.actorId.toUpperCase()
					if (!input) return yield* Effect.fail(new ReadFailure())
					return (yield* Reader).count + input
				}),
		}),
		provided: query({
			input: z.number(),
			result: z.number(),
			permission: 'read',
			handler: (input) =>
				Effect.gen(function* () {
					if (input < 0) return yield* Effect.fail(new ReadFailure())
					return (yield* Reader).count + input
				}),
			middleware: ({ next }) =>
				next().pipe(
					Effect.provideService(Reader, { count: 1 }),
					Effect.provideService(DefaultPolicy, { ready: true }),
					Effect.catchTag('ReadFailure', () => Effect.succeed(0)),
					Effect.catchTag('DefaultFailure', () => Effect.succeed(0)),
				),
		}),
	}),
})
const read = queries.exec('read', 'raw', { invocation: 'one' })
type ReadResult = Assert<Equal<Effect.Success<typeof read>, string>>
type ReadErrors = Assert<
	Equal<Effect.Error<typeof read>, ReadFailure | RequestFailure | PolicyFailure | DefaultFailure>
>
type ReadRequirements = Assert<
	Equal<Effect.Services<typeof read>, Reader | Request | Policy | DefaultPolicy>
>
const provided = queries.exec('provided', 1, { invocation: 'one' })
type ProvidedErrors = Assert<Equal<Effect.Error<typeof provided>, RequestFailure | PolicyFailure>>
type ProvidedRequirements = Assert<Equal<Effect.Services<typeof provided>, Request | Policy>>
const assertions: [ReadResult, ReadErrors, ReadRequirements, ProvidedErrors, ProvidedRequirements] =
	[true, true, true, true, true]
void assertions
// @ts-expect-error unresolved services prevent running an unprovided query
void Effect.runPromise(read)
// @ts-expect-error transformed input is raw string
queries.exec('read', 1, { invocation: 'one' })
// @ts-expect-error unknown operation key
queries.exec('missing', 'raw', { invocation: 'one' })
// @ts-expect-error trusted host requires invocation value
queries.exec('read', 'raw', {})

const ordinary = createEffectQuery({
	context: (host: { actorId: string }) => host,
	operations: ({ query }) => ({
		ordinary: query({
			input: z.string(),
			result: z.number(),
			handler: async (input) => input.length,
		}),
		generated: query({
			input: z.string(),
			result: z.number(),
			handler: (input) =>
				Effect.gen(function* () {
					return yield* Effect.succeed(input.length)
				}),
		}),
		named: query({
			input: z.string(),
			result: z.number(),
			handler: Effect.fn('query.named')(function* (input: string) {
				return yield* Effect.succeed(input.length)
			}),
		}),
	}),
})
const ordinaryExecution = ordinary.exec('ordinary', 'abc', { actorId: 'actor' })
type OrdinaryError = Assert<Equal<Effect.Error<typeof ordinaryExecution>, never>>
type OrdinaryRequirements = Assert<Equal<Effect.Services<typeof ordinaryExecution>, never>>
const ordinaryAssertions: [OrdinaryError, OrdinaryRequirements] = [true, true]
void ordinaryAssertions
void Effect.runPromise(ordinaryExecution)
const enriched = effectOperationFactory<{ actorId: string }, { traceId: string }>()
createEffectQuery({
	context: (host: { actorId: string }) => host,
	operations: () => ({
		read: enriched.query({
			input: z.string(),
			result: z.number(),
			middleware: ({ next }) => next({ context: { traceId: 'trace' } }),
			handler: (input, context) => input.length + context.traceId.length,
		}),
	}),
})
createEffectQuery({
	context: (host: {}) => host,
	operations: () => ({
		read: {
			input: z.string(),
			result: z.number(),
			handler: (input: string) => input.length,
			// @ts-expect-error manually authored query entries also reject command audit vocabulary
			aggregates: ['document'],
		},
	}),
})
createEffectQuery({
	context: (host: {}) => host,
	operations: () => ({
		read: {
			input: z.string(),
			result: z.number(),
			handler: (input: string) => input.length,
			// @ts-expect-error query entries cannot silently accept a command replay validator
			replayResult: z.number(),
		},
	}),
})
const bound = bindEffectQuery({
	observability: new Observability({
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
	}),
	checkPermission: (host: { trusted: true }) =>
		Effect.gen(function* () {
			void host
			yield* Policy
			return yield* Effect.fail(new PolicyFailure())
		}),
})
const boundQuery = bound({
	context: (host: { trusted: true; actorId: string }) => host,
	operations: ({ query }) => ({
		read: query({
			input: z.string(),
			result: z.number(),
			permission: 'read',
			handler: (input) => input.length,
		}),
	}),
})
const boundExecution = boundQuery.exec('read', 'abc', { trusted: true, actorId: 'actor' })
type BoundError = Assert<Equal<Effect.Error<typeof boundExecution>, PolicyFailure>>
type BoundRequirements = Assert<Equal<Effect.Services<typeof boundExecution>, Policy>>
const boundAssertions: [BoundError, BoundRequirements] = [true, true]
void boundAssertions
bound({
	// @ts-expect-error host must satisfy the injected permission checker
	context: (host: { actorId: string }) => host,
	operations: ({ query }) => ({
		read: query({ input: z.string(), result: z.number(), handler: (input) => input.length }),
	}),
})
const optionalBound = bindEffectQuery({
	observability: new Observability({
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
	}),
	checkPermission:
		Math.random() > 0.5
			? (host: { trusted: true }) => {
					void host
				}
			: undefined,
})
optionalBound({
	// @ts-expect-error a possible checker still requires its trusted host capability
	context: (host: { actorId: string }) => host,
	operations: ({ query }) => ({
		read: query({ input: z.string(), result: z.number(), handler: (input) => input.length }),
	}),
})
createEffectQuery({
	context: (host: {}) => host,
	operations: ({ operation }) => ({
		// @ts-expect-error query registries reject ignored command-only preparation hooks
		read: operation({
			input: z.string(),
			result: z.number(),
			handler: (input) => input.length,
			prepare: () => ({ kind: 'execute' }),
		}),
	}),
})
createEffectQuery({
	context: (host: {}) => host,
	operations: ({ operation }) => ({
		// @ts-expect-error query registries reject ignored command-only audit hooks
		read: operation({
			input: z.string(),
			result: z.number(),
			handler: (input) => input.length,
			audit: () => null,
		}),
	}),
})
