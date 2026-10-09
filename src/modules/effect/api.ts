import type {
	ActionBuilder,
	ArgsArrayForOptionalValidator,
	ArgsArrayToObject,
	DefaultArgsForOptionalValidator,
	FunctionVisibility,
	GenericActionCtx,
	GenericDataModel,
	GenericMutationCtx,
	GenericQueryCtx,
	MutationBuilder,
	QueryBuilder,
	RegisteredAction,
	RegisteredMutation,
	RegisteredQuery,
	ReturnValueForOptionalValidator,
} from 'convex/server'
import type { PropertyValidators, Validator } from 'convex/values'
import type { EffectValue } from './operation'
import {
	wrapEffectBuilder,
	type CheckedApiRequirements,
	type EffectApiOptions,
	type EffectApiErrorProjection,
	type EffectApiErrorContract,
	type EffectApiServices,
	type EffectApiHandlerValue,
	type EffectApiContext,
} from './api-runtime'

// Convex's optional-validator grammar, restricted to unknown instead of public any.
type ApiValidator = PropertyValidators | Validator<unknown, 'required', string> | void
type ApiOutput<Returns extends ApiValidator> = [Returns] extends [void]
	? unknown
	: ReturnValueForOptionalValidator<Returns>
export type EffectApiBuilder<
	Ctx,
	Visibility extends FunctionVisibility,
	Kind extends 'query' | 'mutation' | 'action',
	Provider,
	Initialized = {},
> = {
	<
		Args extends ApiValidator,
		Returns extends ApiValidator = void,
		Returned extends EffectApiHandlerValue<ApiOutput<Returns>> = EffectApiHandlerValue<
			ApiOutput<Returns>
		>,
		OneOrZeroArgs extends ArgsArrayForOptionalValidator<Args> =
			DefaultArgsForOptionalValidator<Args>,
	>(
		definition: (
			| { args?: Args; returns?: Returns; handler: (ctx: Ctx, ...args: OneOrZeroArgs) => Returned }
			| ((ctx: Ctx, ...args: OneOrZeroArgs) => Returned)
		) &
			CheckedApiRequirements<Returned, Provider> &
			CheckedApiRequirements<Initialized, Provider>,
	): Kind extends 'query'
		? RegisteredQuery<Visibility, ArgsArrayToObject<OneOrZeroArgs>, Promise<EffectValue<Returned>>>
		: Kind extends 'mutation'
			? RegisteredMutation<
					Visibility,
					ArgsArrayToObject<OneOrZeroArgs>,
					Promise<EffectValue<Returned>>
				>
			: RegisteredAction<
					Visibility,
					ArgsArrayToObject<OneOrZeroArgs>,
					Promise<EffectValue<Returned>>
				>
}

/** Provision request services after the supplied builder has constructed its trusted context. */
export function effectApiBuilder<
	DM extends GenericDataModel,
	V extends FunctionVisibility,
	Provider extends EffectApiServices = import('effect').Context.Context<never>,
	Added extends EffectApiContext = {},
>(
	builder: QueryBuilder<DM, V>,
	options: EffectApiOptions<GenericQueryCtx<DM>, Provider, Added>,
): EffectApiBuilder<GenericQueryCtx<DM> & EffectValue<Added>, V, 'query', Provider, Added>
export function effectApiBuilder<
	DM extends GenericDataModel,
	V extends FunctionVisibility,
	Provider extends EffectApiServices = import('effect').Context.Context<never>,
	Added extends EffectApiContext = {},
>(
	builder: MutationBuilder<DM, V>,
	options: EffectApiOptions<GenericMutationCtx<DM>, Provider, Added>,
): EffectApiBuilder<GenericMutationCtx<DM> & EffectValue<Added>, V, 'mutation', Provider, Added>
export function effectApiBuilder<
	DM extends GenericDataModel,
	V extends FunctionVisibility,
	Provider extends EffectApiServices = import('effect').Context.Context<never>,
	Added extends EffectApiContext = {},
>(
	builder: ActionBuilder<DM, V>,
	options: EffectApiOptions<GenericActionCtx<DM>, Provider, Added>,
): EffectApiBuilder<GenericActionCtx<DM> & EffectValue<Added>, V, 'action', Provider, Added>
export function effectApiBuilder(
	builder: Function,
	options: {
		services?: Function
		context?: Function
		mapError?: EffectApiErrorProjection
		errors?: EffectApiErrorContract
	},
): Function {
	return wrapEffectBuilder(builder, options)
}
