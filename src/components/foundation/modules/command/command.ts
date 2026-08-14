export type Parseable<Output> = Readonly<{ parse: (value: unknown) => Output }>

export type CommandRegistry = Readonly<Record<string, CommandDefinition>>

export type CommandInput<
	Registry extends CommandRegistry,
	Key extends Operation<Registry>,
> = Parsed<Registry[Key]['command']>

export type CommandResult<
	Registry extends CommandRegistry,
	Key extends Operation<Registry>,
> = Parsed<Registry[Key]['result']>

export type CommandExecution<
	Context,
	Registry extends CommandRegistry,
	Key extends Operation<Registry>,
> = Readonly<{
	context: Context
	operation: Key
	definition: Registry[Key]
	command: CommandInput<Registry, Key>
	parseResult: (value: unknown) => CommandResult<Registry, Key>
	/** Runs the handler (result-parsed). Accepts a middleware-enriched context. */
	run: (context?: Context) => Promise<CommandResult<Registry, Key>>
}>

type CommandDefinition = Readonly<{
	command: Parseable<unknown>
	result: Parseable<unknown>
}>

type Operation<Registry extends CommandRegistry> = Extract<
	keyof Registry,
	string
>
type Parsed<Schema> = Schema extends Parseable<infer Output> ? Output : never
type MaybePromise<Value> = Value | Promise<Value>
type Execute<Context, Registry extends CommandRegistry> = <
	Key extends Operation<Registry>,
>(
	execution: CommandExecution<Context, Registry, Key>,
) => Promise<CommandResult<Registry, Key>>

type FixedExecutor<
	Context,
	Registry extends CommandRegistry,
	Key extends Operation<Registry>,
> = Readonly<{
	operation: Key
	handler: (
		context: Context,
		command: CommandInput<Registry, Key>,
	) => MaybePromise<CommandResult<Registry, Key>>
}>

type DynamicExecutor<
	Context,
	Registry extends CommandRegistry,
	Dispatcher,
	Key extends Operation<Registry>,
> = Readonly<{
	dispatcher: Parseable<Dispatcher>
	select: (dispatcher: Dispatcher) => Key
	handler: (
		context: Context,
		command: CommandInput<Registry, Key>,
	) => MaybePromise<CommandResult<Registry, Key>>
}>

class CommandConfigurationError extends Error {
	readonly code = 'COMMAND_OPERATION_NOT_CONFIGURED'
	readonly name = 'CommandConfigurationError'

	constructor() {
		super('The selected command operation is not configured')
	}
}

/** Generic command kernel. Host policy is injected by the owning domain. */
export class Command<Context, const Registry extends CommandRegistry> {
	readonly #operations: Registry
	readonly #execute: Execute<Context, Registry>

	constructor(configuration: {
		readonly operations: Registry
		readonly execute: Execute<Context, Registry>
	}) {
		this.#operations = configuration.operations
		this.#execute = configuration.execute
	}

	exec<const Key extends Operation<Registry>>(
		executor: FixedExecutor<Context, Registry, Key>,
	): (
		context: Context,
		command: CommandInput<Registry, Key>,
	) => Promise<CommandResult<Registry, Key>>
	exec<Dispatcher, const Key extends Operation<Registry>>(
		executor: DynamicExecutor<Context, Registry, Dispatcher, Key>,
	): (
		context: Context,
		command: Dispatcher,
	) => Promise<CommandResult<Registry, Key>>
	exec(
		executor:
			| FixedExecutor<Context, Registry, Operation<Registry>>
			| DynamicExecutor<Context, Registry, unknown, Operation<Registry>>,
	) {
		return async (context: Context, value: unknown) => {
			const selected =
				'operation' in executor
					? { operation: executor.operation, value }
					: (() => {
							const dispatcher = executor.dispatcher.parse(value)
							return {
								operation: executor.select(dispatcher),
								value: dispatcher,
							}
						})()
			if (
				!Object.prototype.hasOwnProperty.call(
					this.#operations,
					selected.operation,
				)
			) {
				throw new CommandConfigurationError()
			}
			const operation = selected.operation as Operation<Registry>
			const definition = this.#operations[operation]
			const command = definition.command.parse(selected.value) as CommandInput<
				Registry,
				Operation<Registry>
			>
			const parseResult = (result: unknown) =>
				definition.result.parse(result) as CommandResult<
					Registry,
					Operation<Registry>
				>
			const handler = executor.handler as (
				context: Context,
				command: CommandInput<Registry, Operation<Registry>>,
			) => MaybePromise<CommandResult<Registry, Operation<Registry>>>
			return this.#execute({
				context,
				operation,
				definition,
				command,
				parseResult,
				run: async (contextOverride?: Context) =>
					parseResult(await handler(contextOverride ?? context, command)),
			})
		}
	}
}
