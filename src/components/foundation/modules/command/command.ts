export type Parseable<Output> = Readonly<{
	parse: <Input>(value: Input) => Output
}>

/** Zod exposes input separately for transforms; plain parsers retain their output contract. */
export type SchemaInput<Schema extends Parseable<unknown>> = Schema extends { _input: infer Input }
	? Input
	: Parsed<Schema>
export type CommandHandlerResult<
	Registry extends CommandRegistry,
	Key extends Operation<Registry>,
> = SchemaInput<Registry[Key]['result']>

export type CommandRegistry = Readonly<Record<string, CommandDefinition>>

/** Values accepted from callers before the command schema parses them. */
export type CommandArgument<
	Registry extends CommandRegistry,
	Key extends Operation<Registry>,
> = SchemaInput<Registry[Key]['command']>

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
	parseResult: <Input>(value: Input) => CommandResult<Registry, Key>
	/** Runs the handler (result-parsed). Accepts a middleware-enriched context. */
	run: (context?: Context) => Promise<CommandResult<Registry, Key>>
	/** Runs without parsing for owners that validate after their middleware chain. */
	runUnparsed: (context?: Context) => Promise<CommandHandlerResult<Registry, Key>>
}>

type CommandDefinition = Readonly<{
	command: Parseable<unknown>
	result: Parseable<unknown>
}>

type Operation<Registry extends CommandRegistry> = Extract<keyof Registry, string>
type Parsed<Schema extends Parseable<unknown>> = ReturnType<Schema['parse']>
type MaybePromise<Value> = Value | Promise<Value>
type Execute<Context, Registry extends CommandRegistry> = <Key extends Operation<Registry>>(
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
	) => MaybePromise<CommandHandlerResult<Registry, Key>>
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
	) => MaybePromise<CommandHandlerResult<Registry, Key>>
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
		command: CommandArgument<Registry, Key>,
	) => Promise<CommandResult<Registry, Key>>
	exec<Dispatcher, const Key extends Operation<Registry>>(
		executor: DynamicExecutor<Context, Registry, Dispatcher, Key>,
	): (context: Context, command: Dispatcher) => Promise<CommandResult<Registry, Key>>
	exec<Dispatcher>(
		executor:
			| FixedExecutor<Context, Registry, Operation<Registry>>
			| DynamicExecutor<Context, Registry, Dispatcher, Operation<Registry>>,
	) {
		return async (
			context: Context,
			value: Dispatcher | CommandArgument<Registry, Operation<Registry>>,
		) => {
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
			if (!Object.prototype.hasOwnProperty.call(this.#operations, selected.operation)) {
				throw new CommandConfigurationError()
			}
			const operation = selected.operation
			const definition = this.#operations[operation]
			// SAFETY: the selected registry entry owns this command schema and its output.
			const command = definition.command.parse(selected.value) as CommandInput<
				Registry,
				Operation<Registry>
			>
			// SAFETY: the selected entry also owns the result schema, including transforms.
			const parseResult = <Input>(result: Input) =>
				definition.result.parse(result) as CommandResult<Registry, Operation<Registry>>
			const handler = executor.handler
			return this.#execute({
				context,
				operation,
				definition,
				command,
				parseResult,
				runUnparsed: async (contextOverride?: Context) =>
					handler(contextOverride ?? context, command),
				run: async (contextOverride?: Context) =>
					parseResult(await handler(contextOverride ?? context, command)),
			})
		}
	}
}
