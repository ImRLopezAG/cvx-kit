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
	audit: (
		resolution: Readonly<{ command: never; result: never }>,
		context: never,
	) => MaybePromise<Omit<AuditEntryInput, 'classification'> | null>
}>

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

	static operation<const Definition extends AuditedOperation>(
		definition: Definition,
	): Definition {
		return definition
	}

	constructor(
		operations: Operations,
		deps: { observability: Observability; writeAudit: AuditWriter },
	) {
		this.#observability = deps.observability
		this.#writeAudit = deps.writeAudit
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
				const result = await execution.run()
				const audit = await execution.definition.audit(
					{ command: execution.command, result } as never,
					execution.context as never,
				)
				if (audit) {
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

export type ApplicationCommand<
	Context,
	Operations extends AuditedRegistry,
> = BoundCommand<Context, Operations>

type CommandConstructor = {
	new <Context, const Operations extends AuditedRegistry>(
		operations: Operations,
	): BoundCommand<Context, Operations>
	operation: (typeof BoundCommand)['operation']
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

	constructor(component: Component, options: FoundationOptions) {
		this.status = component.functions.status
		const observability = new Observability(options.observability)
		this.observability = observability
		const writeAudit = options.observability.writeAudit ?? (() => undefined)
		this.Command = class <
			Context,
			const Operations extends AuditedRegistry,
		> extends BoundCommand<Context, Operations> {
			constructor(operations: Operations) {
				super(operations, { observability, writeAudit })
			}
		}
	}
}

export type {
	CommandExecution,
	CommandInput,
	CommandRegistry,
	CommandResult,
	Parseable,
} from './modules/command/command'
export { Observability } from './modules/observability/observability'
export type {
	CommandObservation,
	ObservabilityOptions,
} from './modules/observability/observability'
export { Query } from './modules/query/query'
export type { QueryExecution } from './modules/query/query'
export { executeResultBoundary, projectResult } from './result'
export type {
	Result,
	ResultBoundary,
	TransactionMetricsContext,
} from './result'
export { emitSemanticEvent } from './telemetry'

// Component definition as default export: `import foundation from "cvx-kit/components/foundation"` → app.use(foundation)
export { default } from "./convex.config"
