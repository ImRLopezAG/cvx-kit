import type {
	AuditEntryInput,
	AuditedRegistry,
	AuditedOperation,
	AnyCommandMiddleware,
} from './client'
import type {
	CommandInput,
	CommandHandlerResult,
	Parseable,
	SchemaInput,
} from './modules/command/command'

type MaybePromise<T> = T | Promise<T>
export type CommandPreparation<Result> =
	| { kind: 'replay'; result: unknown }
	| { kind: 'execute'; complete?: (result: Result) => MaybePromise<void> }
type Parsed<S extends Parseable<unknown>> = ReturnType<S['parse']>
declare const extension: unique symbol
declare const hostContext: unique symbol
export type OperationHostContext<Context> = {
	readonly [hostContext]?: (context: Context) => void
}
export type OperationExtension<Definition> = Definition extends {
	readonly [extension]?: infer Extension
}
	? Extension
	: unknown

type MiddlewareInput<Context, Input, Output, Extension> = {
	operation: string
	context: Context
	command: Input
	next: keyof Extension extends never
		? (options?: { context?: Extension }) => Promise<Output>
		: (options: { context: Extension }) => Promise<Output>
}
type LocalMiddleware<C, I, O, E> = (
	input: MiddlewareInput<C, I, O, E>,
) => Promise<O>
type AuditFor<Aggregate extends string> = Omit<
	AuditEntryInput,
	'classification' | 'aggregate'
> & {
	aggregate: { type: Aggregate; id: string }
}
export type TypedOperation<
	Context,
	Input extends Parseable<unknown>,
	Output extends Parseable<unknown>,
	Aggregates extends readonly string[],
	Extension,
> = OperationHostContext<Context> & {
	readonly command: Input
	readonly result: Output
	readonly classification: string
	readonly permission?: string
	/** Called after permission, inside observation; returns invocation-local hooks. */
	readonly prepare?: (
		context: Context,
		command: Parsed<Input>,
	) => MaybePromise<CommandPreparation<Parsed<Output>>>
	/** Validates stored outputs when result transforms accept a different input shape. */
	readonly replayResult?: Parseable<Parsed<Output>>
	readonly aggregates?: Aggregates
	readonly guard?: (
		context: Context & Extension,
		command: Parsed<Input>,
	) => MaybePromise<void>
	readonly audit: (
		resolution: { command: Parsed<Input>; result: Parsed<Output> },
		context: Context,
	) => MaybePromise<AuditFor<Aggregates[number]> | null>
	readonly [extension]?: Extension
} & (keyof Extension extends never
		? {
				readonly middleware?: readonly LocalMiddleware<
					Context,
					Parsed<Input>,
					SchemaInput<Output>,
					Extension
				>[]
			}
		: {
				readonly middleware: readonly [
					LocalMiddleware<
						Context,
						Parsed<Input>,
						SchemaInput<Output>,
						Extension
					>,
					...LocalMiddleware<
						Context & Extension,
						Parsed<Input>,
						SchemaInput<Output>,
						Record<never, never>
					>[],
				]
			})

type RegistryInput<Context, Operations extends AuditedRegistry> = {
	[Key in Extract<keyof Operations, string>]: {
		operation: Key
		definition: Operations[Key]
		context: Context
		command: CommandInput<Operations, Key>
		next: () => Promise<CommandHandlerResult<Operations, Key>>
	}
}[Extract<keyof Operations, string>]

type StoredOperation<
	Context,
	Input extends Parseable<unknown>,
	Output extends Parseable<unknown>,
	Aggregates extends readonly string[],
	Extension,
> = Omit<
	TypedOperation<Context, Input, Output, Aggregates, Extension>,
	'middleware'
> &
	Pick<AuditedOperation, 'middleware'>

/** Binds host context once; each operation infers its own parsed schemas. */
export function operationFactory<
	Context,
	Extension extends Record<string, unknown> = Record<never, never>,
>() {
	return {
		operation<
			const Input extends Parseable<unknown>,
			const Output extends Parseable<unknown>,
			const Aggregates extends readonly string[] = readonly string[],
		>(
			definition: TypedOperation<
				Context,
				Input,
				Output,
				Aggregates,
				Extension
			>,
		): StoredOperation<Context, Input, Output, Aggregates, Extension> {
			// The kernel selects this definition and parses its input before
			// invoking the heterogeneous middleware registry. Erase only that
			// storage seam; callbacks were checked against these schemas above.
			return definition as StoredOperation<
				Context,
				Input,
				Output,
				Aggregates,
				Extension
			>
		},
		registryMiddleware<const Operations extends AuditedRegistry>(
			operations: Operations & { readonly [Key in keyof Operations]: OperationHostContext<Context> },
			middleware: (
				input: RegistryInput<Context, Operations>,
			) => Promise<unknown>,
		): AnyCommandMiddleware {
			function ownsDefinition(
				input: Parameters<AnyCommandMiddleware>[0],
			): input is Parameters<AnyCommandMiddleware>[0] &
				RegistryInput<Context, Operations> {
				return (
					Object.prototype.hasOwnProperty.call(
						operations,
						input.operation,
					) && operations[input.operation] === input.definition
				)
			}
			return (input) => {
				if (!ownsDefinition(input)) {
					throw new CommandMiddlewareRegistryError(input.operation)
				}
				return middleware(input)
			}
		},
	}
}

class CommandMiddlewareRegistryError extends Error {
	readonly code = 'COMMAND_MIDDLEWARE_REGISTRY_MISMATCH'
	constructor(operation: string) {
		super(
			`Typed middleware does not own the definition of operation "${operation}"`,
		)
		this.name = 'CommandMiddlewareRegistryError'
	}
}
