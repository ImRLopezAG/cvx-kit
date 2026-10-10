/* oxlint-disable anti-slop/no-object-parameters -- Internal helper storage is heterogeneous; the exported mapped signatures validate the schema-paired implementation. */
import type { Effect } from 'effect'
import type { AuditEntryInput } from '../../components/foundation/client'
import type { ContractInput, ContractOutput, ContractSchema } from '../contracts/contract'
import type { DomainOperationContract, ExactOperationKeys } from '../contracts/domain'
import { domainHelpers, type DeclaredSchemas } from '../contracts/binding'
import {
	effectOperationFactory,
	type OperationDefinition,
	type CheckedEffectDefinition,
	type CheckedEffectOperation,
	type CallbackError,
	type CallbackRequirements,
	type EffectPreparation,
} from './operation'

type Supported<A> = A | PromiseLike<A> | Effect.Effect<A, unknown, unknown>
type Audit = Omit<AuditEntryInput, 'classification'> | null
declare const domainKey: unique symbol
type BoundKey<Key> = { readonly [domainKey]: Key }
type Schemas<Entry extends DomainOperationContract> = Pick<Entry, 'input' | 'result'> &
	Omit<Entry, 'input' | 'result'>
type Forbidden = {
	input?: never
	result?: never
	classification?: never
	replayResult?: never
	wire?: never
}
type AuditCallback<Context, Entry extends DomainOperationContract, Value> = (
	resolution: { command: ContractOutput<Entry['input']>; result: ContractOutput<Entry['result']> },
	context: Context,
) => Value
export type SelectedAudit<Definition, Default> = Definition extends { audit: infer Override }
	? Override
	: 'audit' extends keyof Definition
		? Exclude<Definition['audit' & keyof Definition], undefined> | Default
		: Default
export type AuditedOperations<Operations, Default> = {
	[Key in keyof Operations]: Omit<Operations[Key], 'audit'> & {
		audit: SelectedAudit<Operations[Key], Default>
	}
}
export type ExactDomainOperations<Operations, Contracts> = ExactOperationKeys<
	Operations,
	Contracts
> & {
	[Key in keyof Operations]: Operations[Key] extends BoundKey<Key> ? Operations[Key] : never
}

type Helper<
	Context,
	Entry extends DomainOperationContract,
	Key,
	Command extends boolean,
	Default,
	BaseError,
	BaseRequirements,
> = <
	Handler extends Supported<ContractInput<Entry['result']>>,
	Guard extends Supported<void> = never,
	Preparation extends Supported<
		EffectPreparation<ContractOutput<Entry['result']>, unknown, unknown>
	> = never,
	const Aggregates extends readonly string[] = readonly string[],
	AuditReturned extends Supported<Audit> = never,
	Middleware extends Supported<ContractInput<Entry['result']>> = never,
	const Metadata extends object = Record<never, never>,
	const Definition extends object = object,
>(
	implementation: Definition &
		Forbidden &
		Omit<
			OperationDefinition<
				Context,
				Entry['input'],
				Entry['result'],
				Record<never, never>,
				Aggregates,
				Handler,
				Guard,
				Preparation,
				AuditReturned,
				Middleware,
				Metadata,
				BaseError,
				BaseRequirements,
				ContractSchema,
				never
			>,
			'input' | 'result' | 'classification' | 'replayResult' | 'wire'
		> &
		(Command extends true
			? [Default] extends [never]
				? { audit: AuditCallback<Context, Entry, AuditReturned> }
				: {}
			: { audit?: never; prepare?: never; aggregates?: never }),
) => DeclaredSchemas<Entry> &
	CheckedEffectDefinition<
		Context,
		Schemas<Entry> & Definition & BoundKey<Key>,
		BaseError,
		BaseRequirements
	>

type HandlerArguments<
	Options,
	Command extends boolean,
	Default,
	RequiredAudit,
> = Command extends true
	? [Default] extends [never]
		? [options: Options & RequiredAudit]
		: [options?: Options]
	: [options?: Options]

type HandlerHelper<
	Context,
	Entries extends Readonly<Record<string, DomainOperationContract>>,
	Command extends boolean,
	Default,
	BaseError,
	BaseRequirements,
> = <
	const Input extends ContractSchema,
	const Result extends ContractSchema,
	Key extends keyof Entries,
	Handler extends Supported<ContractInput<Result>>,
	Guard extends Supported<void> = never,
	Preparation extends Supported<EffectPreparation<ContractOutput<Result>, unknown, unknown>> =
		never,
	const Aggregates extends readonly string[] = readonly string[],
	AuditReturned extends Supported<Audit> = never,
	Middleware extends Supported<ContractInput<Result>> = never,
	const Metadata extends object = Record<never, never>,
	const Definition extends object = object,
>(
	handler: (input: ContractOutput<Input>, context: Context) => Handler,
	...options: HandlerArguments<
		Definition &
			Forbidden & { handler?: never } & Omit<
				OperationDefinition<
					Context,
					Input,
					Result,
					Record<never, never>,
					Aggregates,
					Handler,
					Guard,
					Preparation,
					AuditReturned,
					Middleware,
					Metadata,
					BaseError,
					BaseRequirements,
					ContractSchema,
					never
				>,
				'handler' | 'input' | 'result' | 'classification' | 'replayResult' | 'wire'
			> &
			(Command extends true ? {} : { audit?: never; prepare?: never; aggregates?: never }),
		Command,
		Default,
		{ audit: AuditCallback<Context, { input: Input; result: Result }, AuditReturned> }
	>
) => DeclaredSchemas<{ input: Input; result: Result }> & {
	handler: (input: ContractOutput<Input>, context: Context) => NoInfer<Handler>
} & NoInfer<Definition> &
	BoundKey<Key> &
	CheckedEffectDefinition<
		Context,
		NoInfer<Definition> & {
			handler: (input: ContractOutput<Input>, context: Context) => Handler
		} & BoundKey<Key>,
		BaseError,
		BaseRequirements
	>

export type DomainEffectFactory<
	Context,
	Entries extends Readonly<Record<string, DomainOperationContract>>,
	Command extends boolean,
	Default = never,
	BaseError = never,
	BaseRequirements = never,
> = {
	[Kind in Command extends true ? 'command' : 'query']: {
		readonly [Key in keyof Entries]: Helper<
			Context,
			Entries[Key],
			Key,
			Command,
			Default,
			BaseError,
			BaseRequirements
		>
	} & { handler: HandlerHelper<Context, Entries, Command, Default, BaseError, BaseRequirements> }
}

export type DomainEffectImplementations<
	Context,
	Entries extends Readonly<Record<string, DomainOperationContract>>,
	Required extends boolean = false,
> = {
	[Key in keyof Entries]: DeclaredSchemas<Pick<Entries[Key], 'input' | 'result'>> &
		BoundKey<Key> &
		CheckedEffectOperation<Context> & {
			handler: (
				input: ContractOutput<Entries[Key]['input']>,
				context: Context,
			) => Supported<ContractInput<Entries[Key]['result']>>
		} & (Required extends true
			? { audit: AuditCallback<Context, Entries[Key], Supported<Audit>> }
			: {})
}

export function domainEffectFactory<
	Context,
	Entries extends Readonly<Record<string, DomainOperationContract>>,
	Command extends boolean,
	Default,
	Guard,
>(
	entries: Entries,
	command: Command,
): DomainEffectFactory<
	Context,
	Entries,
	Command,
	Default,
	CallbackError<Guard>,
	CallbackRequirements<Guard>
> {
	const helpers = domainHelpers(entries)
	// SAFETY: helper signatures check callbacks; registration pairs drafts with their declarations.
	return { [command ? 'command' : 'query']: helpers } as DomainEffectFactory<
		Context,
		Entries,
		Command,
		Default,
		CallbackError<Guard>,
		CallbackRequirements<Guard>
	>
}

export type SharedEffectFactory<Context, Guard> = ReturnType<
	typeof effectOperationFactory<
		Context,
		Record<never, never>,
		NoInfer<CallbackError<Guard>>,
		NoInfer<CallbackRequirements<Guard>>,
		false
	>
>
export type AuditValue = Supported<Audit>
