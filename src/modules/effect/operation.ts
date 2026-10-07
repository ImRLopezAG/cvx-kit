import type { Effect } from 'effect'
import type {
	ContractSchema,
	ContractInput,
	ContractOutput,
	Decoder,
	LegacyParser,
	StandardSchema,
} from '../contracts/contract'
import type { ContractDecoderError, ContractDecoderRequirements } from './schema'
import type { AuditEntryInput } from '../../components/foundation/client'

/** Ordinary failures are defects; only an explicit Effect supplies a typed error. */
export type CallbackError<Value> = Value extends (...arguments_: never[]) => infer Returned
	? CallbackError<Returned>
	: Value extends Effect.Effect<infer Success, infer Error, unknown>
		? Error | CallbackError<Success>
		: Value extends PromiseLike<infer Awaited>
			? CallbackError<Awaited>
			: Value extends readonly (infer Item)[]
				? CallbackError<Item>
				: Value extends { kind: 'execute'; complete?: infer Complete }
					? CallbackError<Complete>
					: never

export type CallbackRequirements<Value> = Value extends (...arguments_: never[]) => infer Returned
	? CallbackRequirements<Returned>
	: Value extends Effect.Effect<infer Success, unknown, infer Requirements>
		? Requirements | CallbackRequirements<Success>
		: Value extends PromiseLike<infer Awaited>
			? CallbackRequirements<Awaited>
			: Value extends readonly (infer Item)[]
				? CallbackRequirements<Item>
				: Value extends { kind: 'execute'; complete?: infer Complete }
					? CallbackRequirements<Complete>
					: never

export type EffectValue<Value> =
	Value extends Effect.Effect<infer Success, unknown, unknown>
		? EffectValue<Success>
		: Value extends PromiseLike<infer Awaited>
			? EffectValue<Awaited>
			: Value

declare const checkedOperation: unique symbol
/** Type-only evidence that the helper checked callbacks against the base context and schemas. */
export type CheckedEffectOperation<Context> = {
	readonly [checkedOperation]: {
		context: (context: Context) => void
		error: unknown
		requirements: unknown
		definition: unknown
	}
}
type CheckedChannels<Context, Error, Requirements, Definition> = {
	readonly [checkedOperation]: {
		context: (context: Context) => void
		error: Error
		requirements: Requirements
		definition: Definition
	}
}
/** Reject stale helper evidence after callbacks or schemas are replaced. */
export type ValidatedEffectOperations<Operations> = {
	[Key in keyof Operations]: Operations[Key] extends {
		readonly [checkedOperation]: { definition: infer Definition }
	}
		? Operations[Key] extends Definition
			? Operations[Key]
			: never
		: never
}
/** Only middleware whose next contract captured a default policy can discharge its channels. */
export type UnwrappedDefaultError<Definition, Guard> = Definition extends { middleware: Function }
	? Definition extends CheckedChannels<never, infer Error, unknown, unknown>
		? Exclude<CallbackError<Guard>, Error>
		: CallbackError<Guard>
	: CallbackError<Guard>
export type UnwrappedDefaultRequirements<Definition, Guard> = Definition extends {
	middleware: Function
}
	? Definition extends CheckedChannels<never, unknown, infer Requirements, unknown>
		? Exclude<CallbackRequirements<Guard>, Requirements>
		: CallbackRequirements<Guard>
	: CallbackRequirements<Guard>
export type EffectOperationArgument<Definition extends { input: ContractSchema }> = ContractInput<
	Definition['input']
>
export type EffectOperationInput<Definition extends { input: ContractSchema }> = ContractOutput<
	Definition['input']
>
export type EffectOperationHandlerResult<Definition extends { result: ContractSchema }> =
	ContractInput<Definition['result']>
export type EffectOperationResult<Definition extends { result: ContractSchema }> = ContractOutput<
	Definition['result']
>

type Hook<Definition, Key extends PropertyKey> = Key extends keyof Definition
	? Definition[Key]
	: never
type Returned<Callback> = Callback extends (...arguments_: never[]) => infer Value ? Value : never
/** A conditional wrapper must retain the unwrapped channels for its absent branch. */
type CoreValue<Definition> = [Returned<Hook<Definition, 'middleware'>>] extends [never]
	? Returned<Hook<Definition, 'handler'>> | Returned<Hook<Definition, 'guard'>>
	: undefined extends Hook<Definition, 'middleware'>
		?
				| Returned<Hook<Definition, 'handler'>>
				| Returned<Hook<Definition, 'guard'>>
				| Returned<Hook<Definition, 'middleware'>>
		: Returned<Hook<Definition, 'middleware'>>
type OutsideHooks = 'prepare' | 'audit' | 'checkPermission' | 'writeAudit'
export type EffectOperationError<Definition> =
	| ContractDecoderError<Hook<Definition, 'input'>>
	| ContractDecoderError<Hook<Definition, 'result'>>
	| ContractDecoderError<Hook<Definition, 'replayResult'>>
	| CallbackError<CoreValue<Definition>>
	| CallbackError<Definition[Extract<keyof Definition, OutsideHooks>]>
export type EffectOperationRequirements<Definition> =
	| ContractDecoderRequirements<Hook<Definition, 'input'>>
	| ContractDecoderRequirements<Hook<Definition, 'result'>>
	| ContractDecoderRequirements<Hook<Definition, 'replayResult'>>
	| CallbackRequirements<CoreValue<Definition>>
	| CallbackRequirements<Definition[Extract<keyof Definition, OutsideHooks>]>

type Supported<Value, Error = unknown, Requirements = unknown> =
	| Value
	| PromiseLike<Value>
	| Effect.Effect<Value, Error, Requirements>
export type EffectPreparation<Result, Error = never, Requirements = never> =
	| { kind: 'replay'; result: unknown }
	| { kind: 'execute'; complete?: (result: Result) => Supported<void, Error, Requirements> }
export type EffectMiddlewareInput<
	Context,
	Input,
	Result,
	Extension,
	Error = never,
	Requirements = never,
> = {
	operation: string
	context: Context
	command: Input
	input: Input
	next: keyof Extension extends never
		? (options?: { context?: Extension }) => Effect.Effect<Result, Error, Requirements>
		: (options: { context: Extension }) => Effect.Effect<Result, Error, Requirements>
}
type Audit<Aggregates extends readonly string[]> = Omit<
	AuditEntryInput,
	'classification' | 'aggregate'
> & {
	aggregate: { type: Aggregates[number]; id: string }
}
type OperationDefinition<
	Context,
	Input extends ContractSchema,
	Output extends ContractSchema,
	Extension,
	Aggregates extends readonly string[],
	Handler,
	Guard,
	Preparation,
	AuditResult,
	Middleware,
	Metadata,
	BaseError,
	BaseRequirements,
	Wire extends ContractSchema,
	Replay extends ContractSchema,
> = {
	input: Input
	result: Output
	handler: (input: ContractOutput<Input>, context: Context & Extension) => Handler
	classification?: string
	permission?: string
	metadata?: Metadata
	aggregates?: Aggregates
	replayResult?: Replay &
		(
			| LegacyParser<ContractOutput<Output>>
			| StandardSchema<unknown, ContractOutput<Output>>
			| Decoder<unknown, ContractOutput<Output>>
		)
	wire?: { schema: Wire; project: (value: ContractOutput<Output>) => ContractInput<Wire> }
	guard?: (context: Context & Extension, input: ContractOutput<Input>) => Guard
	prepare?: (context: Context, input: ContractOutput<Input>) => Preparation
	audit?: (
		resolution: { command: ContractOutput<Input>; result: ContractOutput<Output> },
		context: Context,
	) => AuditResult
} & (keyof Extension extends never
	? {
			middleware?: (
				input: EffectMiddlewareInput<
					Context,
					ContractOutput<Input>,
					ContractInput<Output>,
					Extension,
					BaseError | CallbackError<Handler | Guard>,
					BaseRequirements | CallbackRequirements<Handler | Guard>
				>,
			) => Middleware
		}
	: {
			middleware: (
				input: EffectMiddlewareInput<
					Context,
					ContractOutput<Input>,
					ContractInput<Output>,
					Extension,
					BaseError | CallbackError<Handler | Guard>,
					BaseRequirements | CallbackRequirements<Handler | Guard>
				>,
			) => Middleware
		})

/**
 * Bind context once; middleware wraps the handler/guard channels and may discharge them.
 * Declare contextual guards/handlers before middleware, or annotate their parameters
 * and returned Effect channels when middleware comes first. TypeScript processes
 * context-sensitive object callbacks in declaration order.
 */
export function effectOperationFactory<
	Context,
	Extension extends Record<string, unknown> = Record<never, never>,
	BaseError = never,
	BaseRequirements = never,
>() {
	function operation<
		const Input extends ContractSchema,
		const Output extends ContractSchema,
		Handler extends Supported<ContractInput<Output>>,
		Guard extends Supported<void> = never,
		Preparation extends Supported<EffectPreparation<ContractOutput<Output>, unknown, unknown>> =
			never,
		const Aggregates extends readonly string[] = readonly string[],
		AuditResult extends Supported<Audit<Aggregates> | null> = never,
		Middleware extends Supported<ContractInput<Output>> = never,
		const Metadata extends object = Record<never, never>,
		// Retain whether middleware is guaranteed, conditional, or omitted.
		const Wire extends ContractSchema = ContractSchema,
		const Replay extends ContractSchema = never,
		const Definition extends object = object,
	>(
		definition: Definition &
			OperationDefinition<
				Context,
				Input,
				Output,
				Extension,
				Aggregates,
				Handler,
				Guard,
				Preparation,
				AuditResult,
				Middleware,
				Metadata,
				BaseError,
				BaseRequirements,
				Wire,
				Replay
			>,
	) {
		// SAFETY: the marker is type-only proof of the helper's checked callback contract.
		return definition as NoInfer<Omit<typeof definition, typeof checkedOperation>> &
			CheckedChannels<
				Context,
				BaseError,
				BaseRequirements,
				Omit<typeof definition, typeof checkedOperation>
			>
	}
	function command<
		const Input extends ContractSchema,
		const Output extends ContractSchema,
		Handler extends Supported<ContractInput<Output>>,
		Guard extends Supported<void> = never,
		Preparation extends Supported<EffectPreparation<ContractOutput<Output>, unknown, unknown>> =
			never,
		const Aggregates extends readonly string[] = readonly string[],
		AuditResult extends Supported<Audit<Aggregates> | null> = never,
		Middleware extends Supported<ContractInput<Output>> = never,
		const Metadata extends object = Record<never, never>,
		// Retain whether middleware is guaranteed, conditional, or omitted.
		const Wire extends ContractSchema = ContractSchema,
		const Replay extends ContractSchema = never,
		const Definition extends object = object,
	>(
		definition: Definition &
			OperationDefinition<
				Context,
				Input,
				Output,
				Extension,
				Aggregates,
				Handler,
				Guard,
				Preparation,
				AuditResult,
				Middleware,
				Metadata,
				BaseError,
				BaseRequirements,
				Wire,
				Replay
			> & {
				classification: string
				audit: (
					resolution: { command: ContractOutput<Input>; result: ContractOutput<Output> },
					context: Context,
				) => AuditResult
			},
	) {
		// SAFETY: the marker is type-only proof of the helper's checked callback contract.
		return definition as NoInfer<Omit<typeof definition, typeof checkedOperation>> &
			CheckedChannels<
				Context,
				BaseError,
				BaseRequirements,
				Omit<typeof definition, typeof checkedOperation>
			>
	}
	function query<
		const Input extends ContractSchema,
		const Output extends ContractSchema,
		Handler extends Supported<ContractInput<Output>>,
		Guard extends Supported<void> = never,
		Middleware extends Supported<ContractInput<Output>> = never,
		const Metadata extends object = Record<never, never>,
		const Wire extends ContractSchema = ContractSchema,
		const Replay extends ContractSchema = never,
		const Definition extends object = object,
	>(
		definition: Definition &
			OperationDefinition<
				Context,
				Input,
				Output,
				Extension,
				readonly string[],
				Handler,
				Guard,
				never,
				never,
				Middleware,
				Metadata,
				BaseError,
				BaseRequirements,
				Wire,
				Replay
			> & {
				prepare?: never
				audit?: never
				aggregates?: never
				replayResult?: never
			},
	) {
		// SAFETY: the marker is type-only proof of the helper's checked callback contract.
		return definition as NoInfer<Omit<typeof definition, typeof checkedOperation>> &
			CheckedChannels<
				Context,
				BaseError,
				BaseRequirements,
				Omit<typeof definition, typeof checkedOperation>
			>
	}
	return { operation, command, query }
}
