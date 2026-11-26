import {
	actionGeneric,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	type ActionBuilder,
	type ArgsArrayToObject,
	type DefaultFunctionArgs,
	type FunctionVisibility,
	type GenericActionCtx,
	type GenericDataModel,
	type GenericMutationCtx,
	type GenericQueryCtx,
	type MutationBuilder,
	type QueryBuilder,
} from 'convex/server'
import type {
	GenericValidator,
	Infer,
	ObjectType,
	PropertyValidators,
	VObject,
} from 'convex/values'
import { NoOp, type Registration } from 'convex-helpers/server/customFunctions'
import type { Scope } from 'effect'
import type { KObject } from '../../k/object'
import type { KType, OutputNativeOf } from '../../k/types'
import {
	kCustomQuery,
	type KArgFields,
	type KArgs,
	type KCustomBuilder,
	type KReturns,
} from '../../registration'
import {
	wrapEffectBuilder,
	type EffectApiOptions,
	type EffectApiErrorProjection,
	type EffectApiErrorContract,
	type EffectApiServices,
	type EffectApiHandlerValue,
	type EffectApiContext,
	type ProvidedServices,
} from './api-runtime'
import type { CallbackRequirements, EffectValue } from './operation'

// The argument and result grammar of src/registration.ts: `k` schemas, native validators, or both.
type Expand<Value> = { [Key in keyof Value]: Value[Key] }
type Overwrite<Input, Custom> = keyof Custom extends never ? Input : Omit<Input, keyof Custom> & Custom
type Props<Fields> = Fields extends PropertyValidators ? Fields : never
type InputFields<Fields extends KArgFields> = {
	[Key in keyof Fields]: Fields[Key] extends KType ? Fields[Key]['validator'] : Fields[Key]
}
type OutputFields<Fields extends KArgFields> = {
	[Key in keyof Fields]: Fields[Key] extends KType ? OutputNativeOf<Fields[Key]> : Fields[Key]
}
/** Caller-facing args: a defaulted `k` field is optional, a transformed one has its input type. */
type ArgsInput<Args> = [Args] extends [KObject<any>]
	? Args['_input']
	: [Args] extends [VObject<any, any, any>]
		? Args['type']
		: [Args] extends [KArgFields]
			? ObjectType<Props<InputFields<Args>>>
			: DefaultFunctionArgs
/** Handler-facing args: defaults filled and transforms applied. */
type ArgsOutput<Args> = [Args] extends [KObject<any>]
	? Args['_output']
	: [Args] extends [VObject<any, any, any>]
		? Args['type']
		: [Args] extends [KArgFields]
			? ObjectType<Props<OutputFields<Args>>>
			: DefaultFunctionArgs
type HandlerArgs<Args, Made> = [Args] extends [void]
	? Made extends Record<string, never>
		? [DefaultFunctionArgs]
		: [Expand<DefaultFunctionArgs & Made>]
	: Made extends Record<string, never>
		? [ArgsOutput<Args>]
		: [Expand<ArgsOutput<Args> & Made>]
/** A handler without declared args may still annotate its own (Convex's native rule). */
type HandlerArgsBound<Args, Made> =
	| HandlerArgs<Args, Made>
	| ([Args] extends [void] ? (Made extends Record<string, never> ? [] : never) : never)
type RawArgs<
	Args,
	Custom extends PropertyValidators,
	OneOrZeroArgs extends [] | [DefaultFunctionArgs],
> = [Args] extends [void]
	? Custom extends Record<string, never>
		? ArgsArrayToObject<OneOrZeroArgs>
		: Expand<DefaultFunctionArgs & ObjectType<Custom>>
	: Custom extends Record<string, never>
		? ArgsInput<Args>
		: Expand<ArgsInput<Args> & ObjectType<Custom>>
/** The value a handler must produce: the output side of a `k` schema, which Convex validates. */
type ResultValue<Returns> = [Returns] extends [KType]
	? Returns['_output']
	: [Returns] extends [GenericValidator]
		? Infer<Returns>
		: unknown
type ResultOutput<Returns, Returned> = [Returns] extends [void]
	? EffectValue<Returned>
	: ResultValue<Returns>
type CheckedRequirements<Returned, Services> = [
	Exclude<CallbackRequirements<NoInfer<Returned>>, Services | Scope.Scope>,
] extends [never]
	? unknown
	: never
type Reserved = 'args' | 'returns' | 'handler' | 'skipConvexValidation'

/**
 * One Effect builder over a native Convex builder or a `k` custom builder (`kCustomQuery`, the auth
 * constructors): `args` and `returns` accept `k` schemas and native validators, and the customization's
 * context, made args and extra options are retained.
 */
export type EffectApiBuilder<
	Kind extends 'query' | 'mutation' | 'action',
	CustomArgs extends PropertyValidators,
	// Native Convex context interfaces do not declare a string index signature.
	CustomCtx extends object,
	CustomMadeArgs extends Record<string, unknown>,
	InputCtx,
	Visibility extends FunctionVisibility,
	ExtraArgs extends Record<string, unknown>,
	Services,
	Added = {},
	Initialized = {},
> = {
	<
		Args extends KArgs | void = void,
		Returns extends KReturns | void = void,
		Returned extends EffectApiHandlerValue<
			| ResultValue<Returns>
			| (null extends ResultValue<Returns> ? undefined | void : never)
		> = EffectApiHandlerValue<
			ResultValue<Returns> | (null extends ResultValue<Returns> ? undefined | void : never)
		>,
		OneOrZeroArgs extends HandlerArgsBound<Args, CustomMadeArgs> = HandlerArgs<Args, CustomMadeArgs>,
	>(
		definition: (
			| ({
					args?: Args
					returns?: Returns
					/** Export no validators to Convex; the kit then parses args fully itself (KTD3). */
					skipConvexValidation?: boolean
					handler: (ctx: Overwrite<InputCtx, CustomCtx> & Added, ...args: OneOrZeroArgs) => Returned
			  } & Omit<ExtraArgs, Reserved>)
			| ((ctx: Overwrite<InputCtx, CustomCtx> & Added, ...args: OneOrZeroArgs) => Returned)
		) &
			CheckedRequirements<Returned, Services> &
			CheckedRequirements<Initialized, Services>,
	): Registration<
		Kind,
		Visibility,
		RawArgs<Args, CustomArgs, Extract<OneOrZeroArgs, [] | [DefaultFunctionArgs]>>,
		ResultOutput<Returns, Returned>
	>
}

type Adapter<
	Kind extends 'query' | 'mutation' | 'action',
	Ctx,
	Visibility extends FunctionVisibility,
	Provider,
	Added,
> = EffectApiBuilder<
	Kind,
	{},
	{},
	{},
	Ctx,
	Visibility,
	{},
	ProvidedServices<Provider>,
	EffectValue<Added>,
	Added
>

/** Provision request services after the supplied builder has constructed its trusted context. */
export function effectApiBuilder<
	Kind extends 'query' | 'mutation' | 'action',
	CustomArgs extends PropertyValidators,
	CustomCtx extends Record<string, any>,
	CustomMadeArgs extends Record<string, any>,
	InputCtx,
	Visibility extends FunctionVisibility,
	ExtraArgs extends Record<string, any>,
	Provider extends EffectApiServices = import('effect').Context.Context<never>,
	Added extends EffectApiContext = {},
>(
	builder: KCustomBuilder<
		Kind,
		CustomArgs,
		CustomCtx,
		CustomMadeArgs,
		InputCtx,
		Visibility,
		ExtraArgs
	>,
	options: EffectApiOptions<Overwrite<InputCtx, CustomCtx>, Provider, Added>,
): EffectApiBuilder<
	Kind,
	CustomArgs,
	CustomCtx,
	CustomMadeArgs,
	InputCtx,
	Visibility,
	ExtraArgs,
	ProvidedServices<Provider>,
	EffectValue<Added>,
	Added
>
export function effectApiBuilder<
	DM extends GenericDataModel,
	V extends FunctionVisibility,
	Provider extends EffectApiServices = import('effect').Context.Context<never>,
	Added extends EffectApiContext = {},
>(
	builder: QueryBuilder<DM, V>,
	options: EffectApiOptions<GenericQueryCtx<DM>, Provider, Added>,
): Adapter<'query', GenericQueryCtx<DM>, V, Provider, Added>
export function effectApiBuilder<
	DM extends GenericDataModel,
	V extends FunctionVisibility,
	Provider extends EffectApiServices = import('effect').Context.Context<never>,
	Added extends EffectApiContext = {},
>(
	builder: MutationBuilder<DM, V>,
	options: EffectApiOptions<GenericMutationCtx<DM>, Provider, Added>,
): Adapter<'mutation', GenericMutationCtx<DM>, V, Provider, Added>
export function effectApiBuilder<
	DM extends GenericDataModel,
	V extends FunctionVisibility,
	Provider extends EffectApiServices = import('effect').Context.Context<never>,
	Added extends EffectApiContext = {},
>(
	builder: ActionBuilder<DM, V>,
	options: EffectApiOptions<GenericActionCtx<DM>, Provider, Added>,
): Adapter<'action', GenericActionCtx<DM>, V, Provider, Added>
export function effectApiBuilder(
	builder: Function,
	options: {
		services?: Function
		context?: Function
		mapError?: EffectApiErrorProjection
		errors?: EffectApiErrorContract
	},
): Function {
	return wrapEffectBuilder(nativeBuilders.has(builder) ? kBuilder(builder) : builder, options)
}

/**
 * Convex's own registration functions; every generated `query`/`mutation`/`action` is one of them.
 * Any other builder is a `k` custom builder, which already accepts `k` schemas and must not be
 * wrapped twice (its made args would reach the outer parse).
 */
const nativeBuilders = new Set<Function>([
	queryGeneric,
	mutationGeneric,
	actionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	internalActionGeneric,
])

/** A native builder behind src/registration.ts with no customization, so it accepts `k` schemas. */
function kBuilder(builder: Function): Function {
	// SAFETY: kCustomQuery, kCustomMutation and kCustomAction share one kind-agnostic runtime; the kind
	// is a type-level label only, and the public overloads above carry the native builder's own kind.
	return kCustomQuery(builder as QueryBuilder<GenericDataModel, FunctionVisibility>, NoOp)
}
