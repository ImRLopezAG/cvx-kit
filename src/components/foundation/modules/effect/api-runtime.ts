import { Cause, Effect, Exit } from 'effect'
import type { Context, Scope } from 'effect'
import { normalizeEffect } from './normalize'
import type { CallbackRequirements, EffectValue } from './operation'

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Projection receives any expected failure and its result is always thrown, never returned as public data.
export type EffectApiErrorProjection = (error: unknown) => unknown

export type EffectApiHandlerValue<Value> =
	| Value
	| PromiseLike<Value>
	| Effect.Effect<Value, unknown, unknown>

export type EffectApiServices =
	| Context.Context<never>
	| PromiseLike<Context.Context<never>>
	| Effect.Effect<Context.Context<never>, unknown, Scope.Scope>
export type ProvidedServices<Provider> =
	EffectValue<Provider> extends Context.Context<infer Services> ? Services : never
export type EffectApiOptions<Ctx, Provider extends EffectApiServices> = {
	services: (ctx: Ctx) => Provider
	mapError?: EffectApiErrorProjection
}
export type CheckedApiRequirements<Returned, Provider> = [
	Exclude<CallbackRequirements<NoInfer<Returned>>, ProvidedServices<Provider> | Scope.Scope>,
] extends [never]
	? unknown
	: never

/** Internal erasure is limited to the registration boundary; public adapters check A/E/R. */
export function wrapEffectBuilder(
	builder: Function,
	options: {
		services: Function
		mapError?: EffectApiErrorProjection
	},
): Function {
	return (definition: Function | { handler: Function }) => {
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Native registration explicitly accepts a callable or an object with a handler.
		const original = typeof definition === 'function' ? definition : definition.handler
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Private erased callback receives the context already constructed by the checked native/custom builder.
		const handler = async (ctx: unknown, ...args: unknown[]) => {
			const program = normalizeEffect(() => options.services(ctx)).pipe(
				Effect.flatMap((services) =>
					normalizeEffect(() => original(ctx, ...args)).pipe(Effect.provideContext(services)),
				),
			)
			// SAFETY: checked public signatures prohibit unprovided handler requirements and
			// permit only Scope in providers; services are constructed within this same scope.
			const exit = await Effect.runPromiseExit(
				Effect.scoped(program) as Effect.Effect<unknown, unknown>,
			)
			if (Exit.isSuccess(exit)) return exit.value
			const reason = exit.cause.reasons.length === 1 ? exit.cause.reasons[0] : undefined
			if (reason && Cause.isFailReason(reason)) {
				throw options.mapError ? options.mapError(reason.error) : reason.error
			}
			if (reason && Cause.isDieReason(reason)) throw reason.defect
			throw new Error('Effect API execution failed', { cause: exit.cause })
		}
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve the original native callable or object registration form.
		return builder(typeof definition === 'function' ? handler : { ...definition, handler })
	}
}
