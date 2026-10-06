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
	type EffectApiServices,
	type EffectApiHandlerValue,
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
			CheckedApiRequirements<Returned, Provider>,
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
	Provider extends EffectApiServices,
>(
	builder: QueryBuilder<DM, V>,
	options: EffectApiOptions<GenericQueryCtx<DM>, Provider>,
): EffectApiBuilder<GenericQueryCtx<DM>, V, 'query', Provider>
export function effectApiBuilder<
	DM extends GenericDataModel,
	V extends FunctionVisibility,
	Provider extends EffectApiServices,
>(
	builder: MutationBuilder<DM, V>,
	options: EffectApiOptions<GenericMutationCtx<DM>, Provider>,
): EffectApiBuilder<GenericMutationCtx<DM>, V, 'mutation', Provider>
export function effectApiBuilder<
	DM extends GenericDataModel,
	V extends FunctionVisibility,
	Provider extends EffectApiServices,
>(
	builder: ActionBuilder<DM, V>,
	options: EffectApiOptions<GenericActionCtx<DM>, Provider>,
): EffectApiBuilder<GenericActionCtx<DM>, V, 'action', Provider>
export function effectApiBuilder(
	builder: Function,
	options: { services: Function; mapError?: EffectApiErrorProjection },
): Function {
	return wrapEffectBuilder(builder, options)
}
