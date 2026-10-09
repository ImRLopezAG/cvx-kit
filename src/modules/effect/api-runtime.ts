import { Cause, Context, Effect, Exit } from 'effect'
import type { Scope } from 'effect'
import { ConvexError, type Value } from 'convex/values'
import type { ErrorContract, ErrorDefinitions } from '../contracts/errors'
import { projectErrorCause } from './errors'
import { normalizeEffect } from './normalize'
import type { CallbackRequirements, EffectValue } from './operation'

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Projection receives any expected failure and its result is always thrown, never returned as public data.
export type EffectApiErrorProjection = (error: unknown) => unknown
export type EffectApiErrorContract = Pick<ErrorContract<ErrorDefinitions>, 'project'>

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
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- This inference constraint requires record-shaped additions; each adapter preserves its concrete inferred fields and runtime checks the record boundary.
export type EffectApiContext = EffectApiHandlerValue<Record<string, unknown>>
type KeysOfUnion<Value> = Value extends object ? keyof Value : never
export type CheckedContext<Ctx, Added> =
	Extract<KeysOfUnion<EffectValue<Added>>, keyof Ctx> extends never ? unknown : never
export type EffectApiOptions<Ctx, Provider extends EffectApiServices, Added = {}> = {
	services?: (ctx: Ctx) => Provider
	context?: (ctx: Ctx) => Added & CheckedContext<Ctx, Added>
} & (
	| { errors: EffectApiErrorContract; mapError?: never }
	| { errors?: never; mapError?: EffectApiErrorProjection }
)
export type CheckedApiRequirements<Returned, Provider> = [
	Exclude<CallbackRequirements<NoInfer<Returned>>, ProvidedServices<Provider> | Scope.Scope>,
] extends [never]
	? unknown
	: never

/** Internal erasure is limited to the registration boundary; public adapters check A/E/R. */
export function wrapEffectBuilder(
	builder: Function,
	options: {
		services?: Function
		context?: Function
		mapError?: EffectApiErrorProjection
		errors?: EffectApiErrorContract
	},
): Function {
	return (definition: Function | { handler: Function }) => {
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Native registration explicitly accepts a callable or an object with a handler.
		const original = typeof definition === 'function' ? definition : definition.handler
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Private erased callback receives the context already constructed by the checked native/custom builder.
		const handler = async (ctx: unknown, ...args: unknown[]) => {
			const program = normalizeEffect(() =>
				options.services ? options.services(ctx) : Context.empty(),
			).pipe(
				Effect.flatMap((services) =>
					normalizeEffect(() => (options.context ? options.context(ctx) : {})).pipe(
						Effect.flatMap((added) =>
							Effect.sync(() => {
								// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate erased context additions before enumerating or merging their fields.
								if (added === null || typeof added !== 'object')
									throw Error('Effect API context must be an object')
								const additionsPrototype = Object.getPrototypeOf(added)
								if (additionsPrototype !== Object.prototype && additionsPrototype !== null)
									throw Error('Effect API context additions must be a plain record')
								// SAFETY: native and custom builders construct an object context before invoking this private handler.
								const originalContext = ctx as object
								for (const key of Reflect.ownKeys(added)) {
									if (key in originalContext)
										throw Error(`Effect API context cannot replace ${String(key)}`)
								}
								return options.context
									? Object.create(Object.getPrototypeOf(originalContext), {
											...Object.getOwnPropertyDescriptors(originalContext),
											...Object.getOwnPropertyDescriptors(added),
										})
									: ctx
							}),
						),
						Effect.flatMap((context) => normalizeEffect(() => original(context, ...args))),
						Effect.provideContext(services),
					),
				),
			)
			// SAFETY: checked public signatures prohibit unprovided handler requirements and
			// permit only Scope in providers; services are constructed within this same scope.
			const exit = await Effect.runPromiseExit(
				Effect.scoped(program) as Effect.Effect<unknown, unknown>,
			)
			if (Exit.isSuccess(exit)) return exit.value
			if (options.errors) {
				// SAFETY: declared projection copies validated JSON-safe fields; all other Causes have a fixed safe envelope.
				throw new ConvexError(projectErrorCause(options.errors, exit.cause) as Value)
			}
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
