/* oxlint-disable anti-slop/no-unknown-parameters -- Schema validators and interpreter decoders own these untrusted input boundaries and validate before domain callbacks. */
export type Parseable<Output> = Readonly<{
	parse: <Input>(value: Input) => Output
	parseAsync?: <Input>(value: Input) => Promise<Output>
}>

/** Structural mirror of portable neutral contracts: components cannot import host modules. */
interface ValidationIssue {
	readonly message: string
	readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[]
}
type ValidationResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: readonly ValidationIssue[] }
interface StandardSchema<Input = unknown, Output = unknown> {
	readonly '~standard': {
		readonly version: 1
		readonly vendor: string
		readonly types?: { readonly input: Input; readonly output: Output }
		readonly validate: (
			value: unknown,
		) => ValidationResult<Output> | Promise<ValidationResult<Output>>
	}
}
interface NeutralDecoder<Input = unknown, Output = unknown, Execution = unknown> {
	readonly kind: 'contract'
	readonly types?: { readonly input: Input; readonly output: Output }
	readonly decode: (value: unknown) => Execution
}
export type CommandSchema<Output = unknown> =
	| Parseable<Output>
	| StandardSchema<unknown, Output>
	| NeutralDecoder<unknown, Output, ValidationResult<Output> | Promise<ValidationResult<Output>>>

/** Raw values accepted before decoding, including transform inputs. */
export type SchemaInput<Schema extends CommandSchema> =
	Schema extends NeutralDecoder<infer Input, unknown, unknown>
		? Input
		: Schema extends { _input: infer Input }
			? Input
			: Schema extends StandardSchema<infer Input, unknown>
				? Input
				: SchemaOutput<Schema>
export type SchemaOutput<Schema extends CommandSchema> =
	Schema extends Parseable<unknown>
		? ReturnType<Schema['parse']>
		: Schema extends NeutralDecoder<unknown, infer Output, unknown>
			? Output
			: Schema extends StandardSchema<unknown, infer Output>
				? Output
				: never
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
> = SchemaOutput<Registry[Key]['command']>

export type CommandResult<
	Registry extends CommandRegistry,
	Key extends Operation<Registry>,
> = SchemaOutput<Registry[Key]['result']>

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
	/** Interpreter-owned asynchronous result decoding, preserving the legacy parser. */
	decodeResult?: <Input>(value: Input) => Promise<CommandResult<Registry, Key>>
	/** Runs the handler (result-parsed). Accepts a middleware-enriched context. */
	run: (context?: Context) => Promise<CommandResult<Registry, Key>>
	/** Runs without parsing for owners that validate after their middleware chain. */
	runUnparsed: (context?: Context) => Promise<CommandHandlerResult<Registry, Key>>
}>

type CommandDefinition = Readonly<{
	command: CommandSchema
	result: CommandSchema
}>

type Operation<Registry extends CommandRegistry> = Extract<keyof Registry, string>
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
					: await (async () => {
							const dispatcher = await decodeCommandSchema(executor.dispatcher, value)
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
			const command = (await decodeCommandSchema(
				definition.command,
				selected.value,
			)) as CommandInput<Registry, Operation<Registry>>
			// SAFETY: the selected entry also owns the result schema, including transforms.
			const parseResult = <Input>(result: Input) =>
				parseCommandSchema(definition.result, result) as CommandResult<
					Registry,
					Operation<Registry>
				>
			// SAFETY: selected result schema owns the decoded output, including async transforms.
			const decodeResult = async <Input>(result: Input) =>
				(await decodeCommandSchema(definition.result, result)) as CommandResult<
					Registry,
					Operation<Registry>
				>
			const handler = executor.handler
			return this.#execute({
				context,
				operation,
				definition,
				command,
				parseResult,
				decodeResult,
				runUnparsed: async (contextOverride?: Context) =>
					handler(contextOverride ?? context, command),
				run: async (contextOverride?: Context) =>
					decodeResult(await handler(contextOverride ?? context, command)),
			})
		}
	}
}

/** Legacy synchronous parsing remains available to existing kernel interpreters. */
export function parseCommandSchema<S extends CommandSchema>(
	schema: S,
	value: unknown,
): SchemaOutput<S> {
	if (!('parse' in schema))
		throw new TypeError('This command schema requires asynchronous decoding')
	// SAFETY: this legacy parser belongs to the selected schema.
	return schema.parse(value) as SchemaOutput<S>
}

/** Interpreter-owned decoding awaits validation and leaves thrown/rejected defects intact. */
export async function decodeCommandSchema<S extends CommandSchema>(
	schema: S,
	value: unknown,
): Promise<SchemaOutput<S>> {
	if ('parse' in schema) {
		// SAFETY: parseAsync and parse share the selected legacy schema's output.
		return (await (schema.parseAsync
			? schema.parseAsync(value)
			: schema.parse(value))) as SchemaOutput<S>
	}
	const result = await ('kind' in schema
		? schema.decode(value)
		: schema['~standard'].validate(value))
	if (result.issues !== undefined) throw new CommandValidationError(result.issues)
	// SAFETY: this decoder owns the selected schema's output.
	return result.value as SchemaOutput<S>
}

class CommandValidationError extends Error {
	readonly name = 'CommandValidationError'
	constructor(readonly issues: readonly ValidationIssue[]) {
		super('Command contract validation failed')
	}
}
