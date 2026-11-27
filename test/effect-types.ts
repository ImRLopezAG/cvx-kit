import type { ContractValidationError } from '../src/modules/effect/schema'
import { Context, Effect } from 'effect'
import { k } from '../src/k'
import {
	effectOperationFactory,
	type EffectOperationArgument,
	type EffectOperationResult,
	type EffectOperationError,
	type EffectOperationRequirements,
	type EffectPreparation,
} from '../src/modules/effect/operation'

const define = effectOperationFactory<{ actorId: string }>()
const transformed = define.operation({
	input: k.string().transform((value) => value.length),
	result: k.number().transform((value) => String(value)),
	handler: (input, context) => {
		input.toFixed()
		context.actorId.toUpperCase()
		return Effect.succeed(input)
	},
})
const raw: EffectOperationArgument<typeof transformed> = 'title'
const parsed: EffectOperationResult<typeof transformed> = '5'
void raw
void parsed

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value
class Repository extends Context.Service<Repository, { load: () => number }>()('Repository') {}
class Policy extends Context.Service<Policy, { allowed: boolean }>()('Policy') {}
class HandlerFailure {
	readonly _tag = 'HandlerFailure'
}
class GuardFailure {
	readonly _tag = 'GuardFailure'
}
class CompleteFailure {
	readonly _tag = 'CompleteFailure'
}
class MiddlewareFailure {
	readonly _tag = 'MiddlewareFailure'
}
class AuditFailure {
	readonly _tag = 'AuditFailure'
}
const operations = {
	plain: define.command({
		classification: 'business',
		audit: () => null,
		input: k.string(),
		result: k.number(),
		handler: async (input) => input.length,
	}),
	generated: define.command({
		classification: 'business',
		audit: () => null,
		input: k.number(),
		result: k.number(),
		guard: () =>
			Effect.gen(function* () {
				const policy = yield* Policy
				if (!policy.allowed) return yield* Effect.fail(new GuardFailure())
			}),
		prepare: () =>
			Effect.succeed({
				kind: 'execute' as const,
				complete: () => Effect.fail(new CompleteFailure()),
			}),
		handler: (input, context) =>
			Effect.gen(function* () {
				context.actorId.toUpperCase()
				const repository = yield* Repository
				if (input < 0) return yield* Effect.fail(new HandlerFailure())
				return repository.load() + input
			}),
	}),
	named: define.query({
		input: k.number(),
		result: k.number(),
		handler: Effect.fn('named')(function* (input: number, context: { actorId: string }) {
			context.actorId.toUpperCase()
			const repository = yield* Repository
			return repository.load() + input
		}),
	}),
}
type PlainError = Assert<
	Equal<EffectOperationError<typeof operations.plain>, ContractValidationError>
>
type PlainServices = Assert<Equal<EffectOperationRequirements<typeof operations.plain>, never>>
type GeneratedErrors = Assert<
	Equal<
		EffectOperationError<typeof operations.generated>,
		HandlerFailure | GuardFailure | CompleteFailure | ContractValidationError
	>
>
type GeneratedServices = Assert<
	Equal<EffectOperationRequirements<typeof operations.generated>, Repository | Policy>
>
type NamedServices = Assert<Equal<EffectOperationRequirements<typeof operations.named>, Repository>>
const assertions: [PlainError, PlainServices, GeneratedErrors, GeneratedServices, NamedServices] = [
	true,
	true,
	true,
	true,
	true,
]
void assertions
const middlewareOperation = define.command({
	input: k.number(),
	result: k.number(),
	classification: 'business',
	audit: () =>
		Effect.gen(function* () {
			yield* Policy
			return yield* Effect.fail(new AuditFailure())
		}),
	middleware: ({ next }) => {
		// @ts-expect-error downstream requirements must be supplied by the registry/adapter
		void Effect.runPromise(next())
		return Effect.gen(function* () {
			yield* Policy
			const output = yield* next()
			if (output < 0) return yield* Effect.fail(new MiddlewareFailure())
			return output
		})
	},
	handler: () =>
		Effect.gen(function* () {
			yield* Repository
			return yield* Effect.fail(new HandlerFailure())
		}),
})
type MiddlewareErrors = Assert<
	Equal<
		EffectOperationError<typeof middlewareOperation>,
		MiddlewareFailure | HandlerFailure | AuditFailure | ContractValidationError
	>
>
type MiddlewareServices = Assert<
	Equal<EffectOperationRequirements<typeof middlewareOperation>, Policy | Repository>
>
const middlewareAssertions: [MiddlewareErrors, MiddlewareServices] = [true, true]
void middlewareAssertions
const provided = define.query({
	input: k.number(),
	result: k.number(),
	handler: (input) =>
		Effect.gen(function* () {
			return (yield* Repository).load() + input
		}),
	middleware: ({ next }) => next().pipe(Effect.provideService(Repository, { load: () => 1 })),
})
type ProvidedRequirements = Assert<Equal<EffectOperationRequirements<typeof provided>, never>>
const recovered = define.query({
	input: k.number(),
	result: k.number(),
	handler: () => Effect.fail(new HandlerFailure()),
	middleware: ({ next }) => next().pipe(Effect.catchTag('HandlerFailure', () => Effect.succeed(1))),
})
type RecoveredErrors = Assert<
	Equal<EffectOperationError<typeof recovered>, ContractValidationError>
>
const annotated = define.command({
	input: k.number(),
	result: k.number(),
	classification: 'business',
	audit: () => null,
	prepare: (): EffectPreparation<number> => ({ kind: 'execute', complete: () => undefined }),
	handler: (input) => input,
})
type AnnotatedErrors = Assert<
	Equal<EffectOperationError<typeof annotated>, ContractValidationError>
>
type AnnotatedRequirements = Assert<Equal<EffectOperationRequirements<typeof annotated>, never>>
const recoveryAssertions: [
	ProvidedRequirements,
	RecoveredErrors,
	AnnotatedErrors,
	AnnotatedRequirements,
] = [true, true, true, true]
void recoveryAssertions
const typedCompletion = define.command({
	input: k.number(),
	result: k.number(),
	classification: 'business',
	audit: () => null,
	prepare: (): EffectPreparation<number, CompleteFailure, Policy> => ({
		kind: 'execute',
		complete: () =>
			Effect.gen(function* () {
				yield* Policy
				return yield* Effect.fail(new CompleteFailure())
			}),
	}),
	handler: (input) => input,
})
type TypedCompletionError = Assert<
	Equal<EffectOperationError<typeof typedCompletion>, CompleteFailure | ContractValidationError>
>
type TypedCompletionRequirements = Assert<
	Equal<EffectOperationRequirements<typeof typedCompletion>, Policy>
>
const completionAssertions: [TypedCompletionError, TypedCompletionRequirements] = [true, true]
void completionAssertions
const recoveredGuard = define.query({
	input: k.number(),
	result: k.number(),
	guard: () => Effect.fail(new GuardFailure()),
	handler: (input) => input,
	middleware: ({ next }) => next().pipe(Effect.catchTag('GuardFailure', () => Effect.succeed(1))),
})
type RecoveredGuardError = Assert<
	Equal<EffectOperationError<typeof recoveredGuard>, ContractValidationError>
>
const guardAssertion: RecoveredGuardError = true
void guardAssertion
const shortCircuit = define.query({
	input: k.number(),
	result: k.number(),
	handler: () =>
		Effect.gen(function* () {
			yield* Repository
			return yield* Effect.fail(new HandlerFailure())
		}),
	middleware: () => 1,
})
type ShortCircuitError = Assert<
	Equal<EffectOperationError<typeof shortCircuit>, ContractValidationError>
>
type ShortCircuitRequirements = Assert<
	Equal<EffectOperationRequirements<typeof shortCircuit>, never>
>
const shortCircuitAssertions: [ShortCircuitError, ShortCircuitRequirements] = [true, true]
void shortCircuitAssertions
const optionalProvision = define.query({
	input: k.number(),
	result: k.number(),
	handler: (input) =>
		Effect.gen(function* () {
			return (yield* Repository).load() + input
		}),
	middleware:
		Math.random() > 0.5
			? ({ next }) => next().pipe(Effect.provideService(Repository, { load: () => 1 }))
			: undefined,
})
type OptionalProvisionRequirements = Assert<
	Equal<EffectOperationRequirements<typeof optionalProvision>, Repository>
>
const optionalRecovery = define.query({
	input: k.number(),
	result: k.number(),
	handler: () => Effect.fail(new HandlerFailure()),
	middleware:
		Math.random() > 0.5
			? ({ next }) => next().pipe(Effect.catchTag('HandlerFailure', () => Effect.succeed(1)))
			: undefined,
})
type OptionalRecoveryErrors = Assert<
	Equal<EffectOperationError<typeof optionalRecovery>, HandlerFailure | ContractValidationError>
>
const optionalAssertions: [OptionalProvisionRequirements, OptionalRecoveryErrors] = [true, true]
void optionalAssertions
declare const optionalExecution: Effect.Effect<
	EffectOperationResult<typeof optionalProvision>,
	EffectOperationError<typeof optionalProvision>,
	EffectOperationRequirements<typeof optionalProvision>
>
// @ts-expect-error the absent wrapper branch still needs Repository
void Effect.runPromise(optionalExecution)
// @ts-expect-error command declarations require their audit/classification contract
define.command({ input: k.string(), result: k.number(), handler: () => 1 })
// @ts-expect-error transformed callers supply raw string input
const wrongInput: EffectOperationArgument<typeof transformed> = 4
// @ts-expect-error final output is transformed to string
const wrongOutput: EffectOperationResult<typeof transformed> = 4
void wrongInput
void wrongOutput
define.operation({
	input: k.string(),
	result: k.number(),
	// @ts-expect-error ordinary handler must produce schema's pre-transform input
	handler: () => 'wrong',
})
define.operation({
	input: k.string(),
	result: k.number(),
	// @ts-expect-error Effect success must produce schema's pre-transform input
	handler: () => Effect.succeed('wrong'),
})
const enriched = effectOperationFactory<{ actorId: string }, { traceId: string }>()
enriched.command({
	classification: 'business',
	audit: () => null,
	input: k.string(),
	result: k.number(),
	middleware: ({ next }) => next({ context: { traceId: 'trace' } }),
	handler: (input, context) => input.length + context.traceId.length,
})
enriched.command({
	classification: 'business',
	audit: () => null,
	input: k.string(),
	result: k.number(),
	middleware: ({ next }) => {
		// @ts-expect-error declared enrichment is required
		return next()
	},
	handler: (input) => input.length,
})
define.query({
	input: k.string(),
	result: k.number(),
	handler: (input, context) => {
		// @ts-expect-error enrichment is local to the enriched definition helper
		void context.traceId
		return input.length
	},
})

const guardedDefine = effectOperationFactory<
	{ actorId: string },
	Record<never, never>,
	GuardFailure,
	Repository
>()
const recoveredDefaultGuard = guardedDefine.query({
	input: k.number(),
	result: k.number(),
	handler: (input) => input,
	middleware: ({ next }) =>
		next().pipe(
			Effect.provideService(Repository, { load: () => 1 }),
			Effect.catchTag('GuardFailure', () => Effect.succeed(1)),
		),
})
type RecoveredDefaultGuardError = Assert<
	Equal<EffectOperationError<typeof recoveredDefaultGuard>, ContractValidationError>
>
type RecoveredDefaultGuardRequirements = Assert<
	Equal<EffectOperationRequirements<typeof recoveredDefaultGuard>, never>
>
const defaultGuardAssertions: [RecoveredDefaultGuardError, RecoveredDefaultGuardRequirements] = [
	true,
	true,
]
void defaultGuardAssertions

// Fully annotated callbacks retain exact channels even when middleware is declared first.
const middlewareFirstGuard = define.query({
	input: k.number(),
	result: k.number(),
	middleware: ({ next }) =>
		Effect.gen(function* () {
			return yield* next()
		}),
	guard: (
		_context: { actorId: string },
		_input: number,
	): Effect.Effect<void, GuardFailure, Policy> =>
		Effect.gen(function* () {
			if (!(yield* Policy).allowed) return yield* Effect.fail(new GuardFailure())
		}),
	handler: (
		input: number,
		context: { actorId: string },
	): Effect.Effect<number, HandlerFailure, Repository> =>
		Effect.gen(function* () {
			yield* Repository
			void context.actorId
			if (input < 0) return yield* Effect.fail(new HandlerFailure())
			return input
		}),
})
type MiddlewareFirstRequirements = Assert<
	Equal<EffectOperationRequirements<typeof middlewareFirstGuard>, Policy | Repository>
>
type MiddlewareFirstErrors = Assert<
	Equal<
		EffectOperationError<typeof middlewareFirstGuard>,
		GuardFailure | HandlerFailure | ContractValidationError
	>
>
const middlewareFirstAssertions: [MiddlewareFirstRequirements, MiddlewareFirstErrors] = [true, true]
void middlewareFirstAssertions
