// Internal auth registration seam. Public wrapper contracts match convex-helpers zod4.
// Keep the installed helper's registration branches; only argument conversion differs.
import { pick } from 'convex-helpers'
import { NoOp, type Customization } from 'convex-helpers/server/customFunctions'
import { zodOutputToConvex, type CustomBuilder } from 'convex-helpers/server/zod4'
import { addFieldsToValidator } from 'convex-helpers/validators'
import type {
	ActionBuilder,
	DefaultFunctionArgs,
	FunctionVisibility,
	GenericActionCtx,
	GenericDataModel,
	GenericMutationCtx,
	GenericQueryCtx,
	MutationBuilder,
	QueryBuilder,
} from 'convex/server'
import { ConvexError, type PropertyValidators, type Value } from 'convex/values'
import * as z from 'zod/v4'
import * as zCore from 'zod/v4/core'
import { zodToConvex } from './zod-convex'
import { compactArgumentBoundary } from './querying/filter-boundary'
import { memoize } from './modules/contracts/lazy'

export function zCustomQuery<
	CustomArgsValidator extends PropertyValidators,
	CustomCtx extends Record<string, any>,
	CustomMadeArgs extends Record<string, any>,
	Visibility extends FunctionVisibility,
	DataModel extends GenericDataModel,
	ExtraArgs extends Record<string, any> = object,
>(
	query: QueryBuilder<DataModel, Visibility>,
	customization: Customization<
		GenericQueryCtx<DataModel>,
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		ExtraArgs
	>,
) {
	// SAFETY: the private adapter preserves helper registration semantics; this is
	// the same generic boundary assertion used by the public helper wrappers.
	return customFnBuilder(query, customization) as CustomBuilder<
		'query',
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		GenericQueryCtx<DataModel>,
		Visibility,
		ExtraArgs
	>
}

export function zCustomMutation<
	CustomArgsValidator extends PropertyValidators,
	CustomCtx extends Record<string, any>,
	CustomMadeArgs extends Record<string, any>,
	Visibility extends FunctionVisibility,
	DataModel extends GenericDataModel,
	ExtraArgs extends Record<string, any> = object,
>(
	mutation: MutationBuilder<DataModel, Visibility>,
	customization: Customization<
		GenericMutationCtx<DataModel>,
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		ExtraArgs
	>,
) {
	// SAFETY: the private adapter preserves helper registration semantics; this is
	// the same generic boundary assertion used by the public helper wrappers.
	return customFnBuilder(mutation, customization) as CustomBuilder<
		'mutation',
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		GenericMutationCtx<DataModel>,
		Visibility,
		ExtraArgs
	>
}

export function zCustomAction<
	CustomArgsValidator extends PropertyValidators,
	CustomCtx extends Record<string, any>,
	CustomMadeArgs extends Record<string, any>,
	Visibility extends FunctionVisibility,
	DataModel extends GenericDataModel,
	ExtraArgs extends Record<string, any> = object,
>(
	action: ActionBuilder<DataModel, Visibility>,
	customization: Customization<
		GenericActionCtx<DataModel>,
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		ExtraArgs
	>,
) {
	// SAFETY: the private adapter preserves helper registration semantics; this is
	// the same generic boundary assertion used by the public helper wrappers.
	return customFnBuilder(action, customization) as CustomBuilder<
		'action',
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		GenericActionCtx<DataModel>,
		Visibility,
		ExtraArgs
	>
}

/** Raw (unparsed) function arguments, keyed by the native ctx of one invocation. */
const rawArguments = new WeakMap<object, DefaultFunctionArgs>()

/**
 * The raw arguments of the invocation that produced `ctx`, before zod parsing.
 * Available inside a customization `input` callback; empty for unknown contexts.
 */
export function rawFunctionArgs<DataModel extends GenericDataModel>(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel> | GenericActionCtx<DataModel>,
): DefaultFunctionArgs {
	return rawArguments.get(ctx) ?? {}
}

/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-reflect-get, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- Registration reads arbitrary user definition records by descriptor so declared accessors stay unread. */
/** Descriptor lookup that never invokes an accessor; follows the chain like destructuring does. */
function declared(definition: object, key: PropertyKey): PropertyDescriptor | undefined {
	for (let target: object | null = definition; target; target = Object.getPrototypeOf(target)) {
		const descriptor = Object.getOwnPropertyDescriptor(target, key)
		if (descriptor) return descriptor
	}
	return undefined
}

/** Present means the destructured value would select the declared branch; accessors always do. */
function presence(definition: object, key: PropertyKey) {
	const descriptor = declared(definition, key)
	if (!descriptor) return { present: false, data: false, read: () => undefined }
	if (!('value' in descriptor))
		return { present: true, data: false, read: () => Reflect.get(definition, key) }
	const value = descriptor.value
	return { present: Boolean(value), data: true, read: () => value }
}

const reserved = new Set<PropertyKey>(['args', 'returns', 'handler', 'skipConvexValidation'])

/** Object-rest equivalent that skips the lazily read keys. */
function extraOptions(definition: object): Record<PropertyKey, unknown> {
	const extra: Record<PropertyKey, unknown> = {}
	for (const key of Reflect.ownKeys(definition)) {
		if (reserved.has(key) || !Object.prototype.propertyIsEnumerable.call(definition, key)) continue
		extra[key] = Reflect.get(definition, key)
	}
	return extra
}

/* oxlint-enable anti-slop/no-object-parameters, anti-slop/no-reflect-get, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening */

function argumentFields(args: any) {
	if (!(args instanceof zCore.$ZodType)) return args
	if (args instanceof zCore.$ZodObject) return args._zod.def.shape
	throw new Error('Unsupported zod type as args validator: ' + args.constructor.name)
}

function customFnBuilder(
	builder: (args: any) => any,
	customization: Customization<any, any, any, any, any>,
) {
	// Looking forward to when input / args / ... are optional
	const customInput: Customization<any, any, any, any, any>['input'] =
		customization.input ?? NoOp.input
	const inputArgs = customization.args ?? NoOp.args
	return function customBuilder(fn: any): any {
		// Descriptor reads keep getter-declared args/returns unread until Convex or a call needs them.
		const handler = fn.handler === undefined ? fn : fn.handler
		const skipConvexValidation =
			fn.skipConvexValidation === undefined ? false : fn.skipConvexValidation
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Builders accept a bare handler function or a definition object.
		const extra = typeof fn === 'object' && fn !== null ? extraOptions(fn) : {}
		const declaredArgs = presence(fn, 'args')
		const declaredReturns = presence(fn, 'returns')

		const returnsSchema = memoize(() => {
			const maybeObject = declaredReturns.read()
			return maybeObject && !(maybeObject instanceof zCore.$ZodType)
				? z.object(maybeObject)
				: maybeObject
		})
		const returnsValidator = memoize(() => {
			const returns = returnsSchema()
			return returns ? zodOutputToConvex(returns) : undefined
		})
		const nativeDefinition = (handle: (ctx: any, args: any) => Promise<any>) => {
			// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- The native definition carries opaque validators and the handler.
			const native: Record<string, unknown> = {}
			if (declaredReturns.present && !skipConvexValidation)
				Object.defineProperty(native, 'returns', { enumerable: true, get: returnsValidator })
			native.handler = handle
			return native
		}

		if (declaredArgs.present) {
			const dataArgs = declaredArgs.data
			// Data-declared args keep the registration-time shape check.
			if (dataArgs) argumentFields(declaredArgs.read())
			const argsState = memoize(() => {
				// Capture top-level fields once, matching the native validator's registration lifetime.
				// Nested schemas retain their identity; parsing and callbacks still run per invocation.
				const argsSchema = z.object({ ...argumentFields(declaredArgs.read()) })
				const argsKeys = Object.keys(argsSchema.shape)
				// Skipped validation still rejects schemas Convex cannot represent.
				if (skipConvexValidation) zodToConvex(argsSchema)
				const boundary = skipConvexValidation ? undefined : compactArgumentBoundary(argsSchema)
				return { argsSchema, argsKeys, boundary }
			})
			const argsValidator = memoize(() => {
				const { argsSchema, boundary } = argsState()
				// One conversion preserves graph sharing across all user argument fields.
				return addFieldsToValidator(boundary?.validator ?? zodToConvex(argsSchema), inputArgs)
			})
			const native = nativeDefinition(async (ctx: any, allArgs: any) => {
				const { argsSchema, argsKeys, boundary } = argsState()
				const returns = returnsSchema()
				boundary?.preflight(allArgs)
				rawArguments.set(ctx, allArgs)
				const added = await customInput(ctx, pick(allArgs, Object.keys(inputArgs)), extra)
				const rawArgs = pick(allArgs, argsKeys)
				const parsed = await argsSchema.safeParseAsync(rawArgs)
				if (!parsed.success) {
					throw new ConvexError({
						// SAFETY: serialized Zod issues are the helper's existing Convex Value[] error payload.
						ZodError: JSON.parse(JSON.stringify(parsed.error.issues, null, 2)) as Value[],
					})
				}
				const args = parsed.data
				const finalCtx = { ...ctx, ...added.ctx }
				const finalArgs = { ...args, ...added.args }
				const ret = await handler(finalCtx, finalArgs)
				// We don't catch the error here. It's a developer error and we
				// don't want to risk exposing the unexpected value to the client.
				const result = returns ? await returns.parseAsync(ret === undefined ? null : ret) : ret
				if (added.onSuccess) {
					await added.onSuccess({ ctx, args, result })
				}
				return result
			})
			// Skipping is rare and has no export thunk to defer to, so data args keep registration errors.
			if (skipConvexValidation && dataArgs) argsState()
			if (skipConvexValidation) native.args = undefined
			else Object.defineProperty(native, 'args', { enumerable: true, get: argsValidator })
			return builder(native)
		}
		if (skipConvexValidation && Object.keys(inputArgs).length > 0) {
			throw new Error(
				"If you're using a custom function with arguments for the input " +
					'customization, you cannot skip convex validation.',
			)
		}
		return builder(
			nativeDefinition(async (ctx: any, args: any) => {
				const returns = returnsSchema()
				rawArguments.set(ctx, args)
				const added = await customInput(ctx, args, extra)
				const finalCtx = { ...ctx, ...added.ctx }
				const finalArgs = { ...args, ...added.args }
				const ret = await handler(finalCtx, finalArgs)
				// We don't catch the error here. It's a developer error and we
				// don't want to risk exposing the unexpected value to the client.
				const result = returns ? await returns.parseAsync(ret === undefined ? null : ret) : ret
				if (added.onSuccess) {
					await added.onSuccess({ ctx, args, result })
				}
				return result
			}),
		)
	}
}
