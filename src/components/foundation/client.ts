import {
	Command as CommandKernelClass,
	type CommandExecution,
	type CommandInput,
	type CommandRegistry,
	type CommandResult,
} from './modules/command/command'
import {
	Observability,
	type ObservabilityOptions,
} from './modules/observability/observability'
import { Query } from './modules/query/query'
import { executeResultBoundary, projectResult } from './result'
import { emitSemanticEvent } from './telemetry'

/** Shape handed to the injected audit writer; classification comes from the operation. */
export type AuditEntryInput = {
	operation: string
	actorId: string
	aggregate: { type: string; id: string }
	metadata?: Record<string, unknown>
	classification: string
}

export type AuditWriter = (
	context: never,
	entry: AuditEntryInput,
) => Promise<unknown> | unknown

type MaybePromise<Value> = Value | Promise<Value>
type OperationKey<Operations extends CommandRegistry> = Extract<
	keyof Operations,
	string
>

export type AuditedOperation = Readonly<{
	command: Readonly<{ parse: (value: unknown) => unknown }>
	result: Readonly<{ parse: (value: unknown) => unknown }>
	classification: string
	/**
	 * Permission slug required to execute this operation. Checked through the
	 * Foundation's injected checkPermission BEFORE guards and the handler;
	 * declaring a permission without injecting a checker fails closed.
	 */
	permission?: string
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
	middleware?: readonly CommandMiddleware[]
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
export type CommandMiddleware<Context = never> = (input: {
	operation: string
	command: unknown
	context: Context
	next: (options?: {
		/** Merged into the context handed to inner middleware, guards, handler. */
		context?: Record<string, unknown>
	}) => Promise<unknown>
}) => Promise<unknown>

/** Registry-wide defaults applied to every operation of one Command. */
export type CommandDefaults = Readonly<{
	/** Runs before every operation's own guard. Throw to deny. */
	guard?: (context: never) => MaybePromise<void>
	/** Outermost middleware, in array order, around every operation. */
	middleware?: readonly CommandMiddleware[]
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
	readonly #kernel: CommandKernelClass<Context, Operations>
	readonly #observability: Observability
	readonly #writeAudit: AuditWriter
	readonly #checkPermission: PermissionChecker | undefined
	readonly #defaults: CommandDefaults

	/** Declared aggregate types per operation — introspectable for tests. */
	readonly aggregates: Readonly<{
		[Key in OperationKey<Operations>]: Operations[Key]['aggregates']
	}>

	static operation<const Definition extends AuditedOperation>(
		definition: Definition,
	): Definition {
		return definition
	}

	/** Identity helper that types a middleware against its context. */
	static middleware<Context = never>(
		middleware: CommandMiddleware<Context>,
	): CommandMiddleware<Context> {
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

	exec<const Key extends OperationKey<Operations>>(executor: {
		operation: Key
		handler: (
			context: Context,
			command: CommandInput<Operations, Key>,
		) => MaybePromise<CommandResult<Operations, Key>>
	}) {
		return this.#kernel.exec(executor)
	}

	async #execute<Key extends OperationKey<Operations>>(
		execution: CommandExecution<Context, Operations, Key>,
	): Promise<CommandResult<Operations, Key>> {
		return this.#observability.observe(
			{
				operation: execution.operation,
				classification: execution.definition.classification,
			},
			async () => {
				// Guards run before the handler: permission → default → operation.
				const permission = execution.definition.permission
				if (permission !== undefined) {
					if (!this.#checkPermission) {
						throw new CommandPermissionError(execution.operation)
					}
					await this.#checkPermission(execution.context as never, {
						permission,
						operation: execution.operation,
					})
				}
				const middleware = [
					...(this.#defaults.middleware ?? []),
					...(execution.definition.middleware ?? []),
				]
				const terminal = async (context: unknown) => {
					await this.#defaults.guard?.(context as never)
					await execution.definition.guard?.(
						context as never,
						execution.command as never,
					)
					return execution.run(context as never)
				}
				let deepest = -1
				const dispatch = async (
					index: number,
					context: unknown,
				): Promise<unknown> => {
					if (index <= deepest) {
						throw new CommandMiddlewareError(execution.operation)
					}
					deepest = index
					const layer = middleware[index]
					if (!layer) return terminal(context)
					return layer({
						operation: execution.operation,
						command: execution.command,
						context: context as never,
						next: (options) =>
							dispatch(
								index + 1,
								options?.context
									? { ...(context as object), ...options.context }
									: context,
							),
					})
				}
				// Middleware may transform the return value, so the strict
				// result schema re-parses whatever leaves the chain.
				const result = execution.parseResult(
					await dispatch(0, execution.context),
				)
				const audit = await execution.definition.audit(
					{ command: execution.command, result } as never,
					execution.context as never,
				)
				if (audit) {
					const allowed = execution.definition.aggregates
					if (allowed && !allowed.includes(audit.aggregate.type)) {
						throw new CommandAggregateError(
							execution.operation,
							audit.aggregate.type,
						)
					}
					await this.#writeAudit(execution.context as never, {
						...audit,
						classification: execution.definition.classification,
					})
				}
				return result
			},
		)
	}
}

/** A middleware called next() more than once. */
class CommandMiddlewareError extends Error {
	readonly code = 'COMMAND_MIDDLEWARE_NEXT_REUSED'
	readonly name = 'CommandMiddlewareError'

	constructor(operation: string) {
		super(
			`A middleware for operation "${operation}" called next() more than once`,
		)
	}
}

/** The audit referenced an aggregate type outside the operation's allowlist. */
class CommandAggregateError extends Error {
	readonly code = 'COMMAND_AGGREGATE_NOT_DECLARED'
	readonly name = 'CommandAggregateError'

	constructor(operation: string, aggregateType: string) {
		super(
			`Operation "${operation}" audited aggregate type "${aggregateType}" outside its declared aggregates`,
		)
	}
}

/** Fails closed: an operation declared a permission but no checker exists. */
class CommandPermissionError extends Error {
	readonly code = 'COMMAND_PERMISSION_NOT_CONFIGURED'
	readonly name = 'CommandPermissionError'

	constructor(operation: string) {
		super(
			`Operation "${operation}" declares a permission but the Foundation has no checkPermission`,
		)
	}
}

export type ApplicationCommand<
	Context,
	Operations extends AuditedRegistry,
> = BoundCommand<Context, Operations>

type CommandConstructor = {
	new <Context, const Operations extends AuditedRegistry>(
		operations: Operations,
		defaults?: CommandDefaults,
	): BoundCommand<Context, Operations>
	operation: (typeof BoundCommand)['operation']
	middleware: (typeof BoundCommand)['middleware']
}

/**
 * Host facade for a component that owns no application execution capability.
 * Declared once; the sole source of the command protocol, query kernel, and
 * observability: `const { Command, Query, observability } = new Foundation(...)`.
 */
export class Foundation<
	Component extends FoundationComponentApi = FoundationComponentApi,
> {
	readonly status: Component['functions']['status']
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
		this.Command = class <
			Context,
			const Operations extends AuditedRegistry,
		> extends BoundCommand<Context, Operations> {
			constructor(operations: Operations, defaults?: CommandDefaults) {
				super(operations, {
					observability,
					writeAudit,
					checkPermission,
					defaults,
				})
			}
		}
	}
}

// Kernel CLASSES are deliberately NOT exported: Command, Query, and
// Observability exist only as capabilities of a Foundation instance —
// `const { Command, Query, observability } = new Foundation(...)`. A loose
// import would construct kernels without the injected observability, audit
// writer, and permission checker. Types stay exported for signatures.
export type {
	CommandExecution,
	CommandInput,
	CommandRegistry,
	CommandResult,
	Parseable,
} from './modules/command/command'
export type {
	CommandObservation,
	ObservabilityOptions,
} from './modules/observability/observability'
export type {
	QueryExecution,
	QueryMiddleware,
} from './modules/query/query'
export type {
	Result,
	ResultBoundary,
	TransactionMetricsContext,
} from './result'

// The component definition is deliberately NOT re-exported here: Convex's
// CLI only discovers a component whose resolved file is convex.config.js,
// so hosts must mount via the dedicated subpath:
//   import foundation from 'cvx-kit/components/foundation/convex.config'
