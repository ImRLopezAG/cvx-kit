import type { Value } from 'convex/values'
import {
	Command as CommandKernelClass,
	type CommandExecution,
	type CommandHandlerResult,
	type CommandInput,
	type CommandRegistry,
	type CommandResult,
	type CommandSchema,
	decodeCommandSchema,
	parseCommandSchema,
} from './modules/command/command'
import { Observability, type ObservabilityOptions } from './modules/observability/observability'
import { Query } from './modules/query/query'
import {
	executeCommandLifecycle,
	promiseLifecycle,
	CommandPermissionError,
	type PromiseExecution,
} from './modules/command/lifecycle'
import { executeResultBoundary, projectResult } from './result'
import { emitSemanticEvent } from './telemetry'
import {
	operationFactory,
	type CommandPreparation,
	type OperationExtension,
	type OperationHostContext,
} from './operation'

/** Shape handed to the injected audit writer; classification comes from the operation. */
export type AuditEntryInput = {
	operation: string
	actorId: string
	aggregate: { type: string; id: string }
	metadata?: Record<string, Value>
	classification: string
}

export type AuditWriter<Result = unknown> = (
	context: never,
	entry: AuditEntryInput,
) => MaybePromise<Result>

type MaybePromise<Value> = Value | Promise<Value>
type OperationKey<Operations extends CommandRegistry> = Extract<keyof Operations, string>

export type AuditedOperation = Readonly<{
	command: CommandSchema
	result: CommandSchema
	classification: string
	/**
	 * Permission slug required to execute this operation. Checked through the
	 * Foundation's injected checkPermission BEFORE guards and the handler;
	 * declaring a permission without injecting a checker fails closed.
	 */
	permission?: string
	prepare?: (context: never, command: never) => MaybePromise<CommandPreparation<never>>
	replayResult?: CommandSchema
	/**
	 * Per-operation precondition, after the permission check and the registry
	 * default guard, before the handler. Throw to deny — nothing has run yet.
	 */
	guard?: (context: never, command: never) => MaybePromise<void>
	/**
	 * Allowlist of aggregate types this operation's audit may reference. When
	 * declared, an audit entry whose aggregate.type is not listed throws —
	 * the audit vocabulary is enforced, not advisory.
	 */
	aggregates?: readonly string[]
	/** Per-operation middleware, inside the registry-wide chain. */
	middleware?: readonly AnyCommandMiddleware[]
	audit: (
		resolution: Readonly<{ command: never; result: never }>,
		context: never,
	) => MaybePromise<Omit<AuditEntryInput, 'classification'> | null>
}>

/**
 * Composable, next()-based middleware wrapping [guards → handler]. Runs
 * INSIDE the pipeline's invariants: after the permission check, before the
 * result-schema parse, aggregate allowlist, and audit — so middleware can
 * time, trace, enrich context (`next({ context })`), short-circuit, or
 * transform results, but can never skip authorization, return an invalid
 * result, or desynchronize audit from effects.
 */
export type CommandMiddleware<
	Context = never,
	Extension extends object = object,
	Input = unknown,
	Result = unknown,
> = (input: {
	operation: string
	command: Input
	context: Context
	next: (options?: {
		/** Merged into the context handed to inner middleware, guards, handler. */
		context?: Extension
	}) => Promise<Result>
}) => Promise<Result>

/** Any-context middleware — what registries and operations accept. */
// Contravariant seam: the supertype every typed CommandMiddleware<C, E>
// assigns to. Context, command, and next are contravariant storage slots;
// dispatch restores the selected operation's types before invocation.
export type AnyCommandMiddleware<Input = never, Result = unknown, NextResult = never> = (input: {
	operation: string
	definition?: AuditedOperation
	command: Input
	context: never
	next: (options?: { context?: object }) => Promise<NextResult>
}) => Promise<Result>

/** Registry-wide defaults applied to every operation of one Command. */
export type CommandDefaults = Readonly<{
	/** Runs before every operation's own guard. Throw to deny. */
	guard?: (context: never) => MaybePromise<void>
	/** Outermost middleware, in array order, around every operation. */
	middleware?: readonly AnyCommandMiddleware[]
}>

/** Injected permission policy: throw to deny. Host semantics, kit ordering. */
export type PermissionChecker = (
	context: never,
	input: Readonly<{ permission: string; operation: string }>,
) => MaybePromise<void>

export type AuditedRegistry = Readonly<Record<string, AuditedOperation>>

export type FoundationOptions = Readonly<{
	observability: ObservabilityOptions &
		Readonly<{
			/**
			 * In-transaction audit writer used by Command. Operations that
			 * return an audit record get it written here automatically.
			 */
			writeAudit?: AuditWriter
		}>
	/**
	 * Permission policy for operations that declare a `permission`. Runs
	 * before guards and the handler; throw to deny. An operation with a
	 * permission but no injected checker fails closed.
	 */
	checkPermission?: PermissionChecker
}>

type FoundationComponentApi = Readonly<{
	functions: Readonly<{ status: unknown }>
}>

/**
 * Application command protocol bound to a Foundation instance:
 * validate, observe, execute, and audit. `classification` and `audit()`
 * are mandatory per operation — auditing is type-enforced, not opt-in.
 * Obtain it by destructuring the Foundation: `const { Command } = new Foundation(...)`.
 */
class BoundCommand<Context, const Operations extends AuditedRegistry> {
	static withContext = operationFactory
	readonly #kernel: CommandKernelClass<Context, Operations>
	readonly #observability: Observability
	readonly #writeAudit: AuditWriter
	readonly #checkPermission: PermissionChecker | undefined
	readonly #defaults: CommandDefaults

	/** Declared aggregate types per operation — introspectable for tests. */
	readonly aggregates: Readonly<{
		[Key in OperationKey<Operations>]: Operations[Key]['aggregates']
	}>

	static operation<const Definition extends AuditedOperation>(definition: Definition): Definition {
		return definition
	}

	/**
	 * Identity helper that types a middleware against its context and the
	 * context extension it passes downstream via next({ context }).
	 */
	static middleware<
		Context = never,
		const Extension extends object = object,
		Input = unknown,
		Result = unknown,
	>(
		middleware: CommandMiddleware<Context, Extension, Input, Result>,
	): CommandMiddleware<Context, Extension, Input, Result> {
		return middleware
	}

	constructor(
		operations: Operations,
		deps: {
			observability: Observability
			writeAudit: AuditWriter
			checkPermission?: PermissionChecker
			defaults?: CommandDefaults
		},
	) {
		this.#observability = deps.observability
		this.#writeAudit = deps.writeAudit
		this.#checkPermission = deps.checkPermission
		this.#defaults = deps.defaults ?? {}
		// SAFETY: this map preserves every operations key and selects its aggregates property.
		this.aggregates = Object.freeze(
			Object.fromEntries(
				Object.entries(operations).map(([operation, definition]) => [
					operation,
					definition.aggregates,
				]),
			),
		) as this['aggregates']
		this.#kernel = new CommandKernelClass<Context, Operations>({
			operations,
			execute: (execution) => this.#execute(execution),
		})
	}

	/**
	 * @deprecated Declare handlers inside command({...}) using createEffectFoundation
	 * from cvx-kit/effect, then call exec(operation, input, host).
	 */
	exec<const Key extends OperationKey<Operations>>(executor: {
		operation: Key
		handler: (
			context: Context & OperationExtension<Operations[Key]>,
			command: CommandInput<Operations, Key>,
		) => MaybePromise<CommandHandlerResult<Operations, Key>>
	}) {
		return this.#kernel.exec({
			operation: executor.operation,
			handler: (context, command) =>
				executor.handler(
					// SAFETY: operationFactory requires enrichment middleware before this handler.
					context as Context & OperationExtension<Operations[Key]>,
					command,
				),
		})
	}

	async #execute<Key extends OperationKey<Operations>>(
		execution: CommandExecution<Context, Operations, Key>,
	): Promise<CommandResult<Operations, Key>> {
		const definition = execution.definition
		return this.#observability.observe(
			{ operation: execution.operation, classification: definition.classification },
			() =>
				executeCommandLifecycle<
					PromiseExecution,
					Context,
					CommandInput<Operations, Key>,
					CommandHandlerResult<Operations, Key>,
					CommandResult<Operations, Key>
				>(promiseLifecycle, {
					operation: execution.operation,
					classification: definition.classification,
					context: execution.context,
					command: execution.command,
					permission:
						definition.permission === undefined
							? undefined
							: async () => {
									if (!this.#checkPermission) throw new CommandPermissionError(execution.operation)
									// SAFETY: injected policy consumes this invocation's original host context.
									await this.#checkPermission(execution.context as never, {
										permission: definition.permission!,
										operation: execution.operation,
									})
								},
					prepare: async () => {
						// SAFETY: selected definition and parsed input are paired by the kernel.
						const preparation = await definition.prepare?.(
							execution.context as never,
							execution.command as never,
						)
						if (preparation?.kind !== 'execute') return preparation
						return {
							kind: 'execute' as const,
							complete: preparation.complete
								? async (result: CommandResult<Operations, Key>) => {
										// SAFETY: completion belongs to this operation's validated final result.
										await preparation.complete!(result as never)
									}
								: undefined,
						}
					},
					parseReplay: (value) => {
						if (!definition.replayResult) return execution.parseResult(value)
						// SAFETY: selected replay schema validates this operation's stored output.
						return parseCommandSchema(definition.replayResult, value) as CommandResult<
							Operations,
							Key
						>
					},
					decodeReplay: async (value) => {
						if (!definition.replayResult) {
							return execution.decodeResult
								? execution.decodeResult(value)
								: execution.parseResult(value)
						}
						const replay = definition.replayResult
						// SAFETY: selected replay decoder owns the final output representation.
						return (await decodeCommandSchema(replay, value)) as CommandResult<Operations, Key>
					},
					middleware: [...(this.#defaults.middleware ?? []), ...(definition.middleware ?? [])].map(
						(layer) => async (input) => {
							// SAFETY: selected definition owns this heterogeneous middleware's pre-validation output.
							return layer({
								...input,
								definition,
								// SAFETY: selected command schema owns this heterogeneous storage value.
								command: input.command as never,
								// SAFETY: only heterogeneous storage erases the selected middleware context.
								context: input.context as never,
								// SAFETY: selected operation pairs downstream output with its final schema.
								next: input.next as (options?: { context?: object }) => Promise<never>,
							}) as Promise<CommandHandlerResult<Operations, Key>>
						},
					),
					defaultGuard: async (context) => {
						// SAFETY: default guards consume the downstream middleware context.
						await this.#defaults.guard?.(context as never)
					},
					guard: async (context) => {
						// SAFETY: selected guard consumes its parsed input and enriched context.
						await definition.guard?.(context as never, execution.command as never)
					},
					run: (context) => execution.runUnparsed(context),
					parseResult: execution.parseResult,
					decodeResult: execution.decodeResult,
					audit: async (result) => {
						// SAFETY: audit receives this selected parsed command/result and original context.
						return definition.audit(
							{ command: execution.command, result } as never,
							execution.context as never,
						)
					},
					aggregates: definition.aggregates,
					writeAudit: async (entry) => {
						// SAFETY: host supplied writer for this invocation's original context.
						return this.#writeAudit(execution.context as never, entry)
					},
				}),
		)
	}
}

/** @deprecated Use the registry returned by createEffectFoundation(...).Command from cvx-kit/effect. */
export type ApplicationCommand<Context, Operations extends AuditedRegistry> = BoundCommand<
	Context,
	Operations
>

/**
 * The constructor shape a Foundation instance exposes as `Command`.
 * Exported as a TYPE ONLY so factories (e.g. cvx-kit/crud) can accept the
 * destructured facade class as input without importing any runtime kernel.
 * @deprecated Use createEffectFoundation from cvx-kit/effect and declare handlers inside command({...}).
 */
export type CommandConstructor = {
	/** @deprecated Use createEffectFoundation(...).Command({ context, operations }) from cvx-kit/effect. */
	new <Context, const Operations extends AuditedRegistry>(
		operations: Operations & {
			readonly [Key in keyof Operations]: OperationHostContext<Context>
		},
		defaults?: CommandDefaults,
	): BoundCommand<Context, Operations>
	operation: (typeof BoundCommand)['operation']
	withContext: (typeof BoundCommand)['withContext']
	middleware: (typeof BoundCommand)['middleware']
}

/**
 * Host facade for a component that owns no application execution capability.
 * Declared once; the sole source of the command protocol, query kernel, and
 * observability: `const { Command, Query, observability } = new Foundation(...)`.
 */
export class Foundation<Component extends FoundationComponentApi = FoundationComponentApi> {
	readonly status: Component['functions']['status']
	/** @deprecated Use createEffectFoundation(...).Command from cvx-kit/effect. */
	readonly Command: CommandConstructor
	readonly Query = Query
	readonly observability: Observability
	/** Typed-failure boundary — see result.ts. Facade-bound like the kernels. */
	readonly executeResultBoundary = executeResultBoundary
	readonly projectResult = projectResult
	readonly emitSemanticEvent = emitSemanticEvent

	constructor(component: Component, options: FoundationOptions) {
		this.status = component.functions.status
		const observability = new Observability(options.observability)
		this.observability = observability
		const writeAudit = options.observability.writeAudit ?? (() => undefined)
		const checkPermission = options.checkPermission
		class HostCommand<Context, const Operations extends AuditedRegistry> extends BoundCommand<
			Context,
			Operations
		> {
			constructor(operations: Operations, defaults?: CommandDefaults) {
				super(operations, {
					observability,
					writeAudit,
					checkPermission,
					defaults,
				})
			}
		}
		this.Command = HostCommand
	}
}

// Kernel CLASSES are deliberately NOT exported: Command, Query, and
// Observability exist only as capabilities of a Foundation instance —
// `const { Command, Query, observability } = new Foundation(...)`. A loose
// import would construct kernels without the injected observability, audit
// writer, and permission checker. Types stay exported for signatures.
export type { CommandPreparation, TypedOperation } from './operation'
export type {
	CommandArgument,
	CommandExecution,
	CommandHandlerResult,
	CommandInput,
	CommandRegistry,
	CommandResult,
	SchemaOutput,
	Parseable,
} from './modules/command/command'
export type {
	CommandObservation,
	ObservabilityOptions,
} from './modules/observability/observability'
export type { AnyQueryMiddleware, QueryExecution, QueryMiddleware } from './modules/query/query'
export type { Result, ResultBoundary, TransactionMetricsContext } from './result'

// The component definition is deliberately NOT re-exported here: Convex's
// CLI only discovers a component whose resolved file is convex.config.js,
// so hosts must mount via the dedicated subpath:
//   import foundation from 'cvx-kit/components/foundation/convex.config'
