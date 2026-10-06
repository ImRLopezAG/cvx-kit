import { Effect, Exit } from 'effect'
import type { AuditEntryInput } from '../../client'
import type { Parseable } from '../command/command'
import {
	CommandPermissionError,
	executeCommandLifecycle,
	type ExecutionKind,
	type LifecycleAlgebra,
	type LifecyclePreparation,
} from '../command/lifecycle'
import type { Observability } from '../observability/observability'
import { normalizeEffect, observationFailure } from './normalize'
import {
	effectOperationFactory,
	type CallbackError,
	type CallbackRequirements,
	type EffectValue,
	type EffectOperationArgument,
	type EffectOperationInput,
	type EffectOperationHandlerResult,
	type EffectPreparation,
	type EffectOperationResult,
	type EffectOperationError,
	type EffectOperationRequirements,
	type CheckedEffectOperation,
	type UnwrappedDefaultError,
	type UnwrappedDefaultRequirements,
	type ValidatedEffectOperations,
} from './operation'

type Supported<Value> = Value | PromiseLike<Value> | Effect.Effect<Value, unknown, unknown>
// Heterogeneous storage constraints preserve concrete callbacks in inferred definitions.
// oxlint-disable-next-line anti-slop/no-unknown-returns -- Internal callback storage; selected definitions retain concrete return contracts.
type Callback = (...arguments_: never[]) => Supported<unknown>
// oxlint-disable-next-line anti-slop/no-unknown-returns -- Resolver constraint captures its concrete return in Resolve; it never exposes this storage type at exec.
type Resolver = (host: never) => Supported<unknown>
type HostOf<Resolve extends Resolver> = Parameters<Resolve>[0]
type DomainOf<Resolve extends Resolver> = EffectValue<ReturnType<Resolve>>
type Operation = {
	input: Parseable<unknown>
	result: Parseable<unknown>
	classification: string
	handler: Callback
	audit: Callback
	guard?: Callback
	prepare?: Callback
	middleware?: Callback
	permission?: string
	aggregates?: readonly string[]
	replayResult?: Parseable<unknown>
}
type Registry<Context> = Readonly<
	Record<
		string,
		Pick<Operation, 'input' | 'result' | 'classification' | 'handler' | 'audit'> &
			CheckedEffectOperation<Context>
	>
>
export type EffectCommandDependencies = {
	observability: Observability
	checkPermission?: (
		host: never,
		input: { permission: string; operation: string },
	) => Supported<void>
	// oxlint-disable-next-line anti-slop/no-unknown-returns -- Audit writer storage; its concrete return/error/services remain in Dependencies.
	writeAudit: (host: never, entry: AuditEntryInput) => Supported<unknown>
}
type HostParameter<Policy> = [Exclude<Policy, undefined>] extends [never]
	? unknown
	: // oxlint-disable-next-line anti-slop/no-unknown-returns -- Conditional parameter-extraction predicate, not an executable callback contract.
		Exclude<Policy, undefined> extends (...arguments_: infer Arguments) => Supported<unknown>
		? Arguments extends []
			? unknown
			: Arguments[0]
		: unknown
type PolicyHost<Dependencies extends EffectCommandDependencies> = HostParameter<
	Dependencies['writeAudit']
> &
	HostParameter<Dependencies['checkPermission']>
type HostCompatible<Resolve extends Resolver, Dependencies extends EffectCommandDependencies> = [
	HostOf<Resolve>,
] extends [PolicyHost<Dependencies>]
	? unknown
	: { context: never }
type Factory<Resolve extends Resolver, Guard> = ReturnType<
	typeof effectOperationFactory<
		DomainOf<Resolve>,
		Record<never, never>,
		NoInfer<CallbackError<Guard>>,
		NoInfer<CallbackRequirements<Guard>>
	>
>
export type EffectCommandConfiguration<
	Resolve extends Resolver,
	Operations extends Registry<DomainOf<Resolve>>,
	Guard,
> = {
	context: Resolve
	operations: (
		define: Factory<Resolve, Guard>,
	) => Operations & NoInfer<ValidatedEffectOperations<Operations>>
	defaults?: { guard?: (context: DomainOf<Resolve>) => Guard }
}
type ErrorOf<Definition, Resolve, Dependencies, Guard> =
	| EffectOperationError<Definition>
	| CallbackError<Resolve | Dependencies[keyof Dependencies]>
	| UnwrappedDefaultError<Definition, Guard>
type RequirementsOf<Definition, Resolve, Dependencies, Guard> =
	| EffectOperationRequirements<Definition>
	| CallbackRequirements<Resolve | Dependencies[keyof Dependencies]>
	| UnwrappedDefaultRequirements<Definition, Guard>
interface EffectExecution extends ExecutionKind {
	readonly type: Effect.Effect<this['value'], unknown, unknown>
}
const effectLifecycle: LifecycleAlgebra<EffectExecution> = {
	succeed: Effect.succeed,
	suspend: Effect.suspend,
	flatMap: Effect.flatMap,
}
type RuntimeOperation<Context, Input, Raw, Result> = {
	input: Parseable<Input>
	result: Parseable<Result>
	classification: string
	permission?: string
	aggregates?: readonly string[]
	replayResult?: Parseable<Result>
	handler: (input: Input, context: Context) => Supported<Raw>
	guard?: (context: Context, input: Input) => Supported<void>
	prepare?: (
		context: Context,
		input: Input,
	) => Supported<EffectPreparation<Result, unknown, unknown>>
	audit: (
		resolution: { command: Input; result: Result },
		context: Context,
	) => Supported<Omit<AuditEntryInput, 'classification'> | null>
	middleware?: (input: {
		operation: string
		command: Input
		input: Input
		context: Context
		next: (options?: { context?: object }) => Effect.Effect<Raw, unknown, unknown>
	}) => Supported<Raw>
}

/** Internal registry constructor: the public Foundation binds host policies once. */
export function createEffectCommand<
	Resolve extends Resolver,
	const Operations extends Registry<DomainOf<Resolve>>,
	const Dependencies extends EffectCommandDependencies,
	Guard = never,
>(
	configuration: EffectCommandConfiguration<Resolve, Operations, Guard> &
		Dependencies &
		HostCompatible<Resolve, Dependencies>,
) {
	const operations: Operations =
		configuration.operations(
			effectOperationFactory<
				DomainOf<Resolve>,
				Record<never, never>,
				CallbackError<Guard>,
				CallbackRequirements<Guard>
			>(),
		)
	return {
		exec<Key extends Extract<keyof Operations, string>>(
			operation: Key,
			input: EffectOperationArgument<Operations[Key]>,
			host: HostOf<Resolve>,
		): Effect.Effect<
			EffectOperationResult<Operations[Key]>,
			ErrorOf<Operations[Key], Resolve, Dependencies, Guard>,
			RequirementsOf<Operations[Key], Resolve, Dependencies, Guard>
		> {
			const execution = Effect.suspend(() => {
				if (!Object.prototype.hasOwnProperty.call(operations, operation))
					throw Error('The selected command operation is not configured')
				// SAFETY: this helper checked selected callbacks against their parsed schemas and domain context.
				const definition = operations[operation] as Operations[Key] &
					RuntimeOperation<
						DomainOf<Resolve>,
						EffectOperationInput<Operations[Key]>,
						EffectOperationHandlerResult<Operations[Key]>,
						EffectOperationResult<Operations[Key]>
					>
				// SAFETY: selected command input was parsed by its own paired schema.
				const command = definition.input.parse(input) as EffectOperationInput<Operations[Key]>
				const observation = configuration.observability.start({
					operation,
					classification: definition.classification,
				})
				// SAFETY: resolver identity owns its concrete invocation return and host parameter.
				const resolve = configuration.context as (host: HostOf<Resolve>) => ReturnType<Resolve>
				return normalizeEffect(() => resolve(host)).pipe(
					Effect.flatMap((context) => {
						const lifecycle = executeCommandLifecycle<
							EffectExecution,
							DomainOf<Resolve>,
							EffectOperationInput<Operations[Key]>,
							EffectOperationHandlerResult<Operations[Key]>,
							EffectOperationResult<Operations[Key]>
						>(effectLifecycle, {
							operation,
							classification: definition.classification,
							context,
							command,
							permission:
								definition.permission === undefined
									? undefined
									: () =>
											normalizeEffect(() => {
												if (!configuration.checkPermission)
													throw new CommandPermissionError(operation)
												// SAFETY: HostCompatible proves this invocation satisfies the configured policy host.
												return configuration.checkPermission(host as never, {
													permission: definition.permission!,
													operation,
												})
											}).pipe(Effect.asVoid),
							prepare: () =>
								normalizeEffect(() => definition.prepare?.(context, command)).pipe(
									Effect.map((preparation) => {
										if (preparation?.kind !== 'execute') return preparation
										return {
											kind: 'execute',
											complete: preparation.complete
												? (result) =>
														normalizeEffect(() => preparation.complete!(result)).pipe(Effect.asVoid)
												: undefined,
										} satisfies LifecyclePreparation<
											EffectExecution,
											EffectOperationResult<Operations[Key]>
										>
									}),
								),
							parseReplay: (value) => (definition.replayResult ?? definition.result).parse(value),
							middleware: definition.middleware
								? [
										(input_) =>
											normalizeCommandResult(() =>
												definition.middleware!({ ...input_, input: command }),
											),
									]
								: [],
							defaultGuard: (enriched) =>
								normalizeEffect(() => configuration.defaults?.guard?.(enriched)).pipe(
									Effect.asVoid,
								),
							guard: (enriched) =>
								normalizeEffect(() => definition.guard?.(enriched, command)).pipe(Effect.asVoid),
							run: (enriched) =>
								normalizeCommandResult(() => definition.handler(command, enriched)),
							parseResult: (value) => {
								// SAFETY: selected operation owns this final result parser and its output.
								return definition.result.parse(value) as EffectOperationResult<Operations[Key]>
							},
							audit: (result) =>
								normalizeEffect(() => definition.audit({ command, result }, context)),
							writeAudit: (entry) =>
								normalizeEffect(() => {
									// SAFETY: HostCompatible proves this invocation satisfies the configured writer host.
									return configuration.writeAudit(host as never, entry)
								}),
							aggregates: definition.aggregates,
						})
						return lifecycle
					}),
					Effect.onExit((exit) =>
						Effect.sync(() => {
							if (Exit.isSuccess(exit)) observation.completed()
							else observation.failed(observationFailure(exit.cause))
						}),
					),
				)
			})
			// SAFETY: dispatch selects exactly this operation; callbacks preserve the concrete definition/policy E/R.
			return execution as Effect.Effect<
				EffectOperationResult<Operations[Key]>,
				ErrorOf<Operations[Key], Resolve, Dependencies, Guard>,
				RequirementsOf<Operations[Key], Resolve, Dependencies, Guard>
			>
		},
	}
}

/** Bind trusted application policies without exposing a loose public command kernel. */
export function bindEffectCommand<const Dependencies extends EffectCommandDependencies>(
	dependencies: Dependencies,
) {
	return function command<
		Resolve extends Resolver,
		const Operations extends Registry<DomainOf<Resolve>>,
		Guard = never,
	>(
		configuration: EffectCommandConfiguration<Resolve, Operations, Guard> &
			HostCompatible<Resolve, Dependencies>,
	) {
		return createEffectCommand<Resolve, Operations, Dependencies, Guard>({
			...configuration,
			...dependencies,
		})
	}
}

function normalizeCommandResult<Value>(
	invoke: () => Supported<Value>,
): Effect.Effect<Value, unknown, unknown> {
	// SAFETY: selected definition helper checks the callback's normalized success against the schema input.
	return normalizeEffect(invoke) as Effect.Effect<Value, unknown, unknown>
}
