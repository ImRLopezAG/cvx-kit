import type {
	CommandExecution,
	CommandInput,
	CommandKernel,
	CommandRegistry,
	CommandResult,
	Foundation,
	Observability,
} from './components/foundation/client'

/** Shape handed to the injected audit writer; classification comes from the operation. */
export type AuditEntryInput = {
	operation: string
	actorId: string
	aggregate: { type: string; id: string }
	metadata?: Record<string, unknown>
	classification: string
}

export type AuditWriter<Context> = (
	context: Context,
	entry: AuditEntryInput,
) => Promise<unknown> | unknown

export type ApplicationCommandDeps<Context> = {
	/**
	 * The host's declared Foundation instance — it is the sole provider of
	 * the Command kernel and observability, exactly as in the host app:
	 * `const foundation = new Foundation(components.foundation, options)`.
	 */
	foundation: Foundation
	writeAudit: AuditWriter<Context>
}

type MaybePromise<Value> = Value | Promise<Value>
type Operation<Operations extends CommandRegistry> = Extract<
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

/**
 * Application command protocol: validate, observe, execute, and audit.
 * Auditing is type-enforced — every operation must declare a classification
 * and an audit() factory; observability and the audit writer are injected.
 */
export class ApplicationCommand<
	Context,
	const Operations extends AuditedRegistry,
> {
	readonly #kernel: CommandKernel<Context, Operations>
	readonly #observability: Observability
	readonly #writeAudit: AuditWriter<Context>

	static operation<const Definition extends AuditedOperation>(
		definition: Definition,
	): Definition {
		return definition
	}

	constructor(operations: Operations, deps: ApplicationCommandDeps<Context>) {
		this.#observability = deps.foundation.observability
		this.#writeAudit = deps.writeAudit
		this.#kernel = new deps.foundation.Command<Context, Operations>({
			operations,
			execute: (execution) => this.#execute(execution),
		})
	}

	exec<const Key extends Operation<Operations>>(executor: {
		operation: Key
		handler: (
			context: Context,
			command: CommandInput<Operations, Key>,
		) => MaybePromise<CommandResult<Operations, Key>>
	}) {
		return this.#kernel.exec(executor)
	}

	async #execute<Key extends Operation<Operations>>(
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
					await this.#writeAudit(execution.context, {
						...audit,
						classification: execution.definition.classification,
					})
				}
				return result
			},
		)
	}
}
