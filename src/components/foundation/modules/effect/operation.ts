import type { Effect } from 'effect'
import type { Parseable, SchemaInput } from '../command/command'
import type { AuditEntryInput } from '../../client'

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
	Value extends Effect.Effect<infer Success, unknown, unknown> ? Success : Awaited<Value>
export type EffectOperationArgument<Definition extends { input: Parseable<unknown> }> = SchemaInput<
	Definition['input']
>
export type EffectOperationInput<Definition extends { input: Parseable<unknown> }> = ReturnType<
	Definition['input']['parse']
>
export type EffectOperationHandlerResult<Definition extends { result: Parseable<unknown> }> =
	SchemaInput<Definition['result']>
export type EffectOperationResult<Definition extends { result: Parseable<unknown> }> = ReturnType<
	Definition['result']['parse']
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
	| CallbackError<CoreValue<Definition>>
	| CallbackError<Definition[Extract<keyof Definition, OutsideHooks>]>
export type EffectOperationRequirements<Definition> =
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
	Input extends Parseable<unknown>,
	Output extends Parseable<unknown>,
	Extension,
	Aggregates extends readonly string[],
	Handler,
	Guard,
	Preparation,
	AuditResult,
	Middleware,
	Metadata,
> = {
	input: Input
	result: Output
	handler: (input: ReturnType<Input['parse']>, context: Context & Extension) => Handler
	classification?: string
	permission?: string
	metadata?: Metadata
	aggregates?: Aggregates
	replayResult?: Parseable<ReturnType<Output['parse']>>
	guard?: (context: Context & Extension, input: ReturnType<Input['parse']>) => Guard
	prepare?: (context: Context, input: ReturnType<Input['parse']>) => Preparation
	audit?: (
		resolution: { command: ReturnType<Input['parse']>; result: ReturnType<Output['parse']> },
		context: Context,
	) => AuditResult
} & (keyof Extension extends never
	? {
			middleware?: (
				input: EffectMiddlewareInput<
					Context,
					ReturnType<Input['parse']>,
					SchemaInput<Output>,
					Extension,
					CallbackError<Handler | Guard>,
					CallbackRequirements<Handler | Guard>
				>,
			) => Middleware
		}
	: {
			middleware: (
				input: EffectMiddlewareInput<
					Context,
					ReturnType<Input['parse']>,
					SchemaInput<Output>,
					Extension,
					CallbackError<Handler | Guard>,
					CallbackRequirements<Handler | Guard>
				>,
			) => Middleware
		})

/** Bind context once; middleware wraps the handler/guard channels and may discharge them. */
export function effectOperationFactory<
	Context,
	Extension extends Record<string, unknown> = Record<never, never>,
>() {
	function operation<
		const Input extends Parseable<unknown>,
		const Output extends Parseable<unknown>,
		Handler extends Supported<SchemaInput<Output>>,
		Guard extends Supported<void> = never,
		Preparation extends Supported<
			EffectPreparation<ReturnType<Output['parse']>, unknown, unknown>
		> = never,
		const Aggregates extends readonly string[] = readonly string[],
		AuditResult extends Supported<Audit<Aggregates> | null> = never,
		Middleware extends Supported<SchemaInput<Output>> = never,
		const Metadata extends object = Record<never, never>,
		// Retain whether middleware is guaranteed, conditional, or omitted.
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
				Metadata
			>,
	) {
		return definition
	}
	function command<
		const Input extends Parseable<unknown>,
		const Output extends Parseable<unknown>,
		Handler extends Supported<SchemaInput<Output>>,
		Guard extends Supported<void> = never,
		Preparation extends Supported<
			EffectPreparation<ReturnType<Output['parse']>, unknown, unknown>
		> = never,
		const Aggregates extends readonly string[] = readonly string[],
		AuditResult extends Supported<Audit<Aggregates> | null> = never,
		Middleware extends Supported<SchemaInput<Output>> = never,
		const Metadata extends object = Record<never, never>,
		// Retain whether middleware is guaranteed, conditional, or omitted.
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
				Metadata
			> & {
				classification: string
				audit: (
					resolution: { command: ReturnType<Input['parse']>; result: ReturnType<Output['parse']> },
					context: Context,
				) => AuditResult
			},
	) {
		return definition
	}
	return { operation, command, query: operation }
}
