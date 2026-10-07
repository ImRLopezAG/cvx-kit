import { Effect, Exit } from 'effect'
import type { ContractSchema } from '../contracts/contract'
import { decodeEffectContract } from './schema'
// oxlint-disable-next-line cvx/component-boundaries -- SAFETY: Internal optional adapter shares the Effect-free Foundation lifecycle and types without entering the Convex component deployment graph.
import {
	Observability,
	type ObservabilityOptions,
} from '../../components/foundation/modules/observability/observability'
import { normalizeEffect, observationFailure } from './normalize'
import {
	effectOperationFactory,
	type CallbackError,
	type CallbackRequirements,
	type EffectOperationArgument,
	type EffectOperationError,
	type EffectOperationRequirements,
	type EffectOperationResult,
	type EffectValue,
	type CheckedEffectOperation,
	type UnwrappedDefaultError,
	type UnwrappedDefaultRequirements,
	type ValidatedEffectOperations,
} from './operation'

type Supported<Value> = Value | PromiseLike<Value> | Effect.Effect<Value, unknown, unknown>
type QueryDefinition = {
	input: ContractSchema
	result: ContractSchema
	// oxlint-disable-next-line anti-slop/no-unknown-returns -- Internal heterogeneous storage; selected schemas restore the concrete result at exec.
	handler: (input: never, context: never) => unknown
	classification?: string
	permission?: string
	metadata?: object
	// oxlint-disable-next-line anti-slop/no-unknown-returns -- Internal hook storage retains the concrete definition separately.
	guard?: (context: never, input: never) => unknown
	// oxlint-disable-next-line anti-slop/no-unknown-returns -- Internal hook storage retains the concrete definition separately.
	middleware?: (input: never) => unknown
}
type QueryRegistry<Context> = Readonly<
	Record<
		string,
		Pick<QueryDefinition, 'input' | 'result' | 'handler'> &
			CheckedEffectOperation<Context> & {
				prepare?: never
				audit?: never
				aggregates?: never
				replayResult?: never
			}
	>
>
type OperationKey<Operations> = Extract<keyof Operations, string>

class QueryMiddlewareError extends Error {
	readonly code = 'QUERY_MIDDLEWARE_NEXT_REUSED'
	readonly name = 'QueryMiddlewareError'
	constructor() {
		super('A query middleware called next() more than once')
	}
}
class QueryConfigurationError extends Error {
	readonly code = 'QUERY_OPERATION_NOT_CONFIGURED'
	readonly name = 'QueryConfigurationError'
	constructor() {
		super('The selected query operation is not configured')
	}
}
class QueryPermissionError extends Error {
	readonly code = 'QUERY_PERMISSION_CHECKER_MISSING'
	readonly name = 'QueryPermissionError'
	constructor() {
		super('Query permission requires an injected permission checker')
	}
}

/** Injectable domain queries compose lazily; the API chooses native function kind. */
export function createEffectQuery<
	Host,
	ContextReturned,
	const Operations extends QueryRegistry<EffectValue<ContextReturned>>,
	PermissionReturned = never,
	GuardReturned extends Supported<void> = never,
>(configuration: {
	context: (host: Host) => ContextReturned
	operations: (
		definitions: ReturnType<
			typeof effectOperationFactory<
				EffectValue<ContextReturned>,
				Record<never, never>,
				NoInfer<CallbackError<GuardReturned>>,
				NoInfer<CallbackRequirements<GuardReturned>>
			>
		>,
	) => Operations & NoInfer<ValidatedEffectOperations<Operations>>
	checkPermission?: (
		host: Host,
		input: { permission: string; operation: string },
	) => PermissionReturned
	defaults?: { metadata?: object; guard?: (context: EffectValue<ContextReturned>) => GuardReturned }
	observability?: ObservabilityOptions | Observability
}) {
	const definitions = effectOperationFactory<
		EffectValue<ContextReturned>,
		Record<never, never>,
		CallbackError<GuardReturned>,
		CallbackRequirements<GuardReturned>
	>()
	const operations: Operations = configuration.operations(definitions)
	const observability =
		configuration.observability instanceof Observability
			? configuration.observability
			: new Observability(
					configuration.observability ?? {
						enabled: false,
						classifyError: () => ({ outcome: 'failed', errorCode: 'UNEXPECTED' }),
					},
				)

	function exec<const Key extends OperationKey<Operations>>(
		operation: Key,
		input: EffectOperationArgument<Operations[Key]>,
		host: Host,
	): Effect.Effect<
		EffectOperationResult<Operations[Key]>,
		| EffectOperationError<Operations[Key]>
		| CallbackError<ContextReturned | PermissionReturned>
		| UnwrappedDefaultError<Operations[Key], GuardReturned>,
		| EffectOperationRequirements<Operations[Key]>
		| CallbackRequirements<ContextReturned | PermissionReturned>
		| UnwrappedDefaultRequirements<Operations[Key], GuardReturned>
	> {
		const execution = Effect.suspend(() => {
			if (!Object.prototype.hasOwnProperty.call(operations, operation)) {
				return Effect.die(new QueryConfigurationError())
			}
			// SAFETY: operation helpers check hooks before this heterogeneous storage seam.
			const definition: QueryDefinition = operations[operation]
			return Effect.flatMap(decodeEffectContract(definition.input, input), (parsedInput) => {
				const observation = observability.start({
					operation,
					classification: definition.classification ?? 'query',
				})
				const run = Effect.gen(function* () {
					if (definition.permission !== undefined) {
						const check = configuration.checkPermission
						if (!check) return yield* Effect.die(new QueryPermissionError())
						yield* normalizeEffect(() =>
							check(host, { permission: definition.permission!, operation }),
						)
					}
					const context = yield* normalizeEffect(() => configuration.context(host))
					const metadata = { ...configuration.defaults?.metadata, ...definition.metadata }
					const core = (current: EffectValue<ContextReturned>) =>
						Effect.gen(function* () {
							const guard = configuration.defaults?.guard
							if (guard) yield* normalizeEffect(() => guard(current))
							if (definition.guard)
								yield* normalizeEffect(() => {
									// SAFETY: selected schemas and context own the stored guard parameters.
									return definition.guard!(current as never, parsedInput as never)
								})
							return yield* normalizeEffect(() => {
								// SAFETY: selected schemas and context own the stored handler parameters.
								return definition.handler(parsedInput as never, current as never)
							})
						})
					let usedNext = false
					const middleware = definition.middleware
					const output = middleware
						? yield* normalizeEffect(() => {
								// SAFETY: the selected helper checked this middleware's input and next contract.
								return middleware({
									operation,
									input: parsedInput,
									command: parsedInput,
									context,
									metadata,
									next: (options?: { context?: object }) =>
										Effect.suspend(() => {
											if (usedNext) return Effect.die(new QueryMiddlewareError())
											usedNext = true
											return core(
												options?.context ? Object.assign({}, context, options.context) : context,
											)
										}),
								} as never)
							})
						: yield* core(context)
					return yield* decodeEffectContract(definition.result, output)
				})
				return run.pipe(
					Effect.onExit((exit) =>
						Effect.sync(() => {
							if (Exit.isSuccess(exit)) observation.completed()
							else {
								observation.failed(observationFailure(exit.cause))
							}
						}),
					),
				)
			})
		})
		// SAFETY: selected schemas own A; concrete callbacks and the wrapped middleware
		// own E/R. No interpreter or runner executes this Effect before the caller does.
		return execution as ReturnType<typeof exec<Key>>
	}
	return { exec }
}

type Policy<Dependencies> = 'checkPermission' extends keyof Dependencies
	? Dependencies['checkPermission']
	: never
// oxlint-disable-next-line anti-slop/no-unknown-returns -- Conditional type extracts the host; no unknown result is exposed by the registry.
type CallbackHost<Callback> = Callback extends (host: infer Host, input: never) => unknown
	? Host
	: never
type CallbackReturned<Callback> = Callback extends (...arguments_: never[]) => infer Returned
	? Returned
	: never
type PolicyHost<Dependencies> = [CallbackHost<Policy<Dependencies>>] extends [never]
	? unknown
	: CallbackHost<Policy<Dependencies>>
type PolicyReturned<Dependencies> = CallbackReturned<Policy<Dependencies>>
export type EffectQueryDependencies = {
	observability: Observability
	// oxlint-disable-next-line anti-slop/no-unknown-returns -- Host policy storage is erased; the bound generic dependency retains its concrete E/R.
	checkPermission?: (host: never, input: { permission: string; operation: string }) => unknown
}

/** The public Foundation binds trusted application policies once. */
export function bindEffectQuery<const Dependencies extends EffectQueryDependencies>(
	dependencies: Dependencies,
) {
	return function query<
		Host extends PolicyHost<Dependencies>,
		ContextReturned,
		const Operations extends QueryRegistry<EffectValue<ContextReturned>>,
		GuardReturned extends Supported<void> = never,
	>(configuration: {
		context: (host: Host) => ContextReturned
		operations: (
			definitions: ReturnType<
				typeof effectOperationFactory<
					EffectValue<ContextReturned>,
					Record<never, never>,
					NoInfer<CallbackError<GuardReturned>>,
					NoInfer<CallbackRequirements<GuardReturned>>
				>
			>,
		) => Operations & NoInfer<ValidatedEffectOperations<Operations>>
		defaults?: {
			metadata?: object
			guard?: (context: EffectValue<ContextReturned>) => GuardReturned
		}
	}) {
		// SAFETY: Host is constrained to the trusted checker's host type; its concrete
		// return is retained while restoring the erased invocation argument slot.
		const checkPermission = dependencies.checkPermission as (
			host: Host,
			input: { permission: string; operation: string },
		) => PolicyReturned<Dependencies>
		return createEffectQuery<
			Host,
			ContextReturned,
			Operations,
			PolicyReturned<Dependencies>,
			GuardReturned
		>({
			...configuration,
			observability: dependencies.observability,
			checkPermission: dependencies.checkPermission ? checkPermission : undefined,
		})
	}
}
