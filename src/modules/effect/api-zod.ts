import type { ArgsArrayToObject, DefaultFunctionArgs, FunctionVisibility } from 'convex/server'
import type { ObjectType, PropertyValidators } from 'convex/values'
import type { Registration } from 'convex-helpers/server/customFunctions'
import type { CustomBuilder } from 'convex-helpers/server/zod4'
import type { Scope } from 'effect'
import type * as zCore from 'zod/v4/core'
import {
	wrapEffectBuilder,
	type EffectApiOptions,
	type ProvidedServices,
	type EffectApiServices,
	type EffectApiHandlerValue,
	type EffectApiContext,
} from './api-runtime'
import type { CallbackRequirements, EffectValue } from './operation'

type Fields = Record<string, zCore.$ZodType>
type ArgumentsValidator = Fields | zCore.$ZodObject<Fields> | void
type ResultValidator = zCore.$ZodType | Fields | void
type Expand<Value> = { [Key in keyof Value]: Value[Key] }
type Overwrite<Input, Custom> = Omit<Input, keyof Custom> & Custom
type ArgsInput<Validator extends ArgumentsValidator> = [Validator] extends [
	zCore.$ZodObject<Fields>,
]
	? [zCore.input<Validator>]
	: Validator extends Record<string, never>
		? [Record<never, never>]
		: [Validator] extends [Fields]
			? [zCore.input<zCore.$ZodObject<Validator, zCore.$strict>>]
			: [DefaultFunctionArgs]
type ArgsOutput<Validator extends ArgumentsValidator> = [Validator] extends [
	zCore.$ZodObject<Fields>,
]
	? [zCore.output<Validator>]
	: [Validator] extends [Fields]
		? [zCore.output<zCore.$ZodObject<Validator, zCore.$strict>>]
		: [DefaultFunctionArgs]
type HandlerArgs<Validator extends ArgumentsValidator, Made> =
	Made extends Record<string, never>
		? ArgsOutput<Validator>
		: [Expand<ArgsOutput<Validator>[0] & Made>]
type RawArgs<
	Validator extends ArgumentsValidator,
	Custom extends PropertyValidators,
> = ArgsArrayToObject<
	Custom extends Record<string, never>
		? ArgsInput<Validator>
		: [Expand<ArgsInput<Validator>[0] & ObjectType<Custom>>]
>
type ResultInput<Validator extends ResultValidator> = [Validator] extends [zCore.$ZodType]
	? zCore.input<Validator>
	: [Validator] extends [Fields]
		? zCore.input<zCore.$ZodObject<Validator>>
		: unknown
type ResultOutput<Validator extends ResultValidator, Returned> = [Validator] extends [void]
	? EffectValue<Returned>
	: [Validator] extends [zCore.$ZodType]
		? zCore.output<Validator>
		: [Validator] extends [Fields]
			? zCore.output<zCore.$ZodObject<Validator, zCore.$strict>>
			: never
type CheckedRequirements<Returned, Services> = [
	Exclude<CallbackRequirements<NoInfer<Returned>>, Services | Scope.Scope>,
] extends [never]
	? unknown
	: never

/** Retains the installed Zod custom builder's raw/parsed boundaries and customization options. */
export type EffectZodApiBuilder<
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
		Args extends ArgumentsValidator,
		Returns extends ResultValidator = void,
		Returned extends EffectApiHandlerValue<
			ResultInput<Returns> | (null extends ResultInput<Returns> ? undefined | void : never)
		> = EffectApiHandlerValue<
			ResultInput<Returns> | (null extends ResultInput<Returns> ? undefined | void : never)
		>,
	>(
		definition: (
			| ({
					args?: Args
					returns?: Returns
					skipConvexValidation?: boolean
					handler: (
						ctx: Overwrite<InputCtx, CustomCtx> & Added,
						...args: HandlerArgs<Args, CustomMadeArgs>
					) => Returned
			  } & Omit<ExtraArgs, 'args' | 'returns' | 'handler' | 'skipConvexValidation'>)
			| ((
					ctx: Overwrite<InputCtx, CustomCtx> & Added,
					...args: HandlerArgs<Args, CustomMadeArgs>
			  ) => Returned)
		) &
			CheckedRequirements<Returned, Services> &
			CheckedRequirements<Initialized, Services>,
	): Registration<Kind, Visibility, RawArgs<Args, CustomArgs>, ResultOutput<Returns, Returned>>
}

/** Build request services after the original custom builder resolves its trusted context. */
export function effectZodApiBuilder<
	Kind extends 'query' | 'mutation' | 'action',
	CustomArgs extends PropertyValidators,
	CustomCtx extends object,
	CustomMadeArgs extends Record<string, unknown>,
	InputCtx,
	Visibility extends FunctionVisibility,
	ExtraArgs extends Record<string, unknown>,
	Provider extends EffectApiServices = import('effect').Context.Context<never>,
	Added extends EffectApiContext = {},
>(
	builder: CustomBuilder<
		Kind,
		CustomArgs,
		CustomCtx,
		CustomMadeArgs,
		InputCtx,
		Visibility,
		ExtraArgs
	>,
	options: EffectApiOptions<Overwrite<InputCtx, CustomCtx>, Provider, Added>,
): EffectZodApiBuilder<
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
> {
	// SAFETY: Runtime substitution changes only the handler. The original builder retains validation,
	// customization, registration kind and visibility; the public call signature above checks Effects.
	return wrapEffectBuilder(builder, options) as EffectZodApiBuilder<
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
}
