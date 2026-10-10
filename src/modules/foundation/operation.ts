/* oxlint-disable anti-slop/no-object-parameters -- Internal helper storage is heterogeneous; the exported mapped signatures validate the schema-paired implementation. */
import type { AuditEntryInput } from '../../components/foundation/client'
import type { ContractInput, ContractOutput, NeutralSchema } from '../contracts/contract'
import type { DomainOperationContract, ExactOperationKeys } from '../contracts/domain'
import { domainHelpers, type DeclaredSchemas } from '../contracts/binding'

type Supported<A> = A | PromiseLike<A>
export type Audit = Omit<AuditEntryInput, 'classification'> | null
export type NormalEntry = DomainOperationContract & {
	input: NeutralSchema
	result: NeutralSchema
	replayResult?: NeutralSchema
	wire?: { schema: NeutralSchema; project: Function }
}
declare const checkedOperation: unique symbol
export type CheckedDefinition<Context, Definition, Key = unknown> = NoInfer<Definition> & {
	readonly [checkedOperation]: {
		context: (context: Context) => void
		definition: Definition
		key: Key
	}
}
export type CheckedOperation<Context> = {
	readonly [checkedOperation]: {
		context: (context: Context) => void
		definition: unknown
		key: unknown
	}
}
export type ValidatedOperations<Operations> = {
	[Key in keyof Operations]: Operations[Key] extends {
		readonly [checkedOperation]: { definition: infer Definition }
	}
		? Operations[Key] extends Definition
			? Operations[Key]
			: never
		: never
}
export type ExactOperations<Operations, Entries> = ExactOperationKeys<Operations, Entries> & {
	[Key in keyof Operations]: Operations[Key] extends { readonly [checkedOperation]: { key: Key } }
		? Operations[Key]
		: never
}
type Definition<Context, Entry extends NormalEntry> = {
	handler: (
		input: ContractOutput<Entry['input']>,
		context: Context,
	) => Supported<ContractInput<Entry['result']>>
	permission?: string
	metadata?: object
	aggregates?: readonly string[]
	guard?: (context: Context, input: ContractOutput<Entry['input']>) => Supported<void>
	prepare?: (
		context: Context,
		input: ContractOutput<Entry['input']>,
	) => Supported<
		| { kind: 'replay'; result: unknown }
		| { kind: 'execute'; complete?: (result: ContractOutput<Entry['result']>) => Supported<void> }
	>
	audit?: (
		resolution: {
			command: ContractOutput<Entry['input']>
			result: ContractOutput<Entry['result']>
		},
		context: Context,
	) => Supported<Audit>
	middleware?: (input: {
		operation: string
		input: ContractOutput<Entry['input']>
		command: ContractOutput<Entry['input']>
		context: Context
		metadata: object
		next: (options?: { context?: object }) => Promise<ContractInput<Entry['result']>>
	}) => Supported<ContractInput<Entry['result']>>
}
type CommandRules<
	Context,
	Entry extends NormalEntry,
	Command extends boolean,
	Required extends boolean,
> = Command extends false
	? { audit?: never; prepare?: never; aggregates?: never; replayResult?: never }
	: Required extends true
		? { audit: NonNullable<Definition<Context, Entry>['audit']> }
		: {}
type Forbidden = {
	input?: never
	result?: never
	classification?: never
	replayResult?: never
	wire?: never
}
type HandlerOptions<
	Context,
	Input extends NeutralSchema,
	Result extends NeutralSchema,
	Command extends boolean,
	Required extends boolean,
> = Omit<Definition<Context, { input: Input; result: Result }>, 'handler'> &
	Forbidden & { handler?: never } & CommandRules<
		Context,
		{ input: Input; result: Result },
		Command,
		Required
	>
type HandlerArguments<Options, Required extends boolean> = Required extends true
	? [options: Options]
	: [options?: Options]

export type DomainFactory<
	Context,
	Entries extends Readonly<Record<string, NormalEntry>>,
	Command extends boolean,
	Required extends boolean,
> = {
	[Kind in Command extends true ? 'command' : 'query']: {
		[Key in keyof Entries]: <const Implementation extends object>(
			implementation: Implementation &
				Definition<Context, Entries[Key]> &
				Forbidden &
				CommandRules<Context, Entries[Key], Command, Required>,
		) => DeclaredSchemas<Pick<Entries[Key], 'input' | 'result'>> &
			CheckedDefinition<Context, Entries[Key] & Implementation, Key>
	} & {
		handler: <
			const Input extends NeutralSchema,
			const Result extends NeutralSchema,
			Key extends keyof Entries,
			Handler extends Supported<ContractInput<Result>>,
			const Implementation extends object = Record<never, never>,
		>(
			handler: (input: ContractOutput<Input>, context: Context) => Handler,
			...options: HandlerArguments<
				Implementation & HandlerOptions<Context, Input, Result, Command, Required>,
				Command extends true ? Required : false
			>
		) => DeclaredSchemas<{ input: Input; result: Result }> &
			CheckedDefinition<
				Context,
				NoInfer<Implementation> & {
					handler: (input: ContractOutput<Input>, context: Context) => Handler
				},
				Key
			>
	}
}
export type DomainImplementations<
	Context,
	Entries extends Readonly<Record<string, NormalEntry>>,
	Command extends boolean,
	Required extends boolean,
> = {
	[Key in keyof Entries]: DeclaredSchemas<Pick<Entries[Key], 'input' | 'result'>> &
		CheckedDefinition<
			Context,
			Definition<Context, Entries[Key]> & CommandRules<Context, Entries[Key], Command, Required>,
			Key
		>
}
export function domainFactory<
	Context,
	Entries extends Readonly<Record<string, NormalEntry>>,
	Command extends boolean,
	Required extends boolean,
>(entries: Entries, command: Command): DomainFactory<Context, Entries, Command, Required> {
	const helpers = domainHelpers(entries)
	// SAFETY: helper signatures check callbacks; registration pairs drafts with their declarations.
	return { [command ? 'command' : 'query']: helpers } as DomainFactory<
		Context,
		Entries,
		Command,
		Required
	>
}
export function operationFactory<Context, Required extends boolean = true>() {
	function command<
		const Input extends NeutralSchema,
		const Result extends NeutralSchema,
		const Wire extends NeutralSchema,
		const Replay extends NeutralSchema,
		const Implementation extends object,
	>(
		implementation: Implementation & {
			input: Input
			result: Result
			classification: string
			replayResult?: Replay &
				(ContractOutput<Replay> extends ContractOutput<Result> ? unknown : never)
			wire?: { schema: Wire; project: (result: ContractOutput<Result>) => ContractInput<Wire> }
		} & Definition<Context, { input: Input; result: Result }> &
			CommandRules<Context, { input: Input; result: Result }, true, Required>,
	) {
		// SAFETY: this type-only evidence records the complete helper-checked definition.
		return implementation as CheckedDefinition<Context, typeof implementation>
	}
	function query<
		const Input extends NeutralSchema,
		const Result extends NeutralSchema,
		const Wire extends NeutralSchema,
		const Implementation extends object,
	>(
		implementation: Implementation & {
			input: Input
			result: Result
			classification?: string
			wire?: { schema: Wire; project: (result: ContractOutput<Result>) => ContractInput<Wire> }
		} & Definition<Context, { input: Input; result: Result }> &
			CommandRules<Context, { input: Input; result: Result }, false, true>,
	) {
		// SAFETY: this type-only evidence records the complete helper-checked definition.
		return implementation as CheckedDefinition<Context, typeof implementation>
	}
	return { command, query }
}
export type InlineFactory<Context, Required extends boolean> = ReturnType<
	typeof operationFactory<Context, Required>
>
