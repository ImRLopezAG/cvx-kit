// cvx-kit 2 function registration: custom query/mutation/action builders over `k` schemas and native
// Convex validators. Same customization contract as convex-helpers' customQuery.
//
// What Convex reads, and when:
// - At registration (`query(definition)`): only `handler`. `exportArgs`/`exportReturns` are closures.
// - At deploy analysis (first `exportArgs()`/`exportReturns()`): the `args`/`returns` getters on the
//   native definition, which build the native validators once (input side for args, output side for
//   returns) and memoise them.
// - Per call: nothing from the definition. The kit runs a schema's declared behaviour (KTD3) and only
//   when the args declare any; the decision is made on the first call and cached.
import { pick } from 'convex-helpers'
import { NoOp, type Customization, type Registration } from 'convex-helpers/server/customFunctions'
import { addFieldsToValidator, validate } from 'convex-helpers/validators'
import type {
	ActionBuilder,
	ArgsArrayToObject,
	DefaultFunctionArgs,
	FunctionVisibility,
	GenericActionCtx,
	GenericDataModel,
	GenericMutationCtx,
	GenericQueryCtx,
	MutationBuilder,
	QueryBuilder,
	ValidatorTypeToReturnType,
} from 'convex/server'
import {
	v,
	type GenericValidator,
	type Infer,
	type ObjectType,
	type PropertyValidators,
	type VObject,
} from 'convex/values'
import { KValidationError, type KIssue } from './k/issues'
import {
	argumentErrors,
	sanitizeArgumentIssues,
	type ArgumentFailure,
	type ArgumentFailurePolicy,
} from './modules/contracts/errors'
import { KObject, object } from './k/object'
import { transformPath, hasDeclaredBehaviour, runDeclared } from './k/parse'
import { KSchema } from './k/schema'
import type { KFields, KNode, KType, OutputNativeOf } from './k/types'
import { memoize } from './modules/contracts/lazy'
import { compactArgumentBoundary } from './querying/filter-boundary'

/** One declared argument: a `k` schema or a native Convex validator. */
export type KArgField = KType | GenericValidator

/** A plain object of argument fields; `k` and native fields may be mixed. */
export type KArgFields = Readonly<Record<string, KArgField>>

/** What `args` accepts: a field object, a `k.object(...)` or a native `v.object(...)`. */
export type KArgs = KArgFields | KObject<any> | VObject<any, any, 'required'>

/** What `returns` accepts: a `k` schema (its output side is exported) or a native validator. */
export type KReturns = KType | GenericValidator

type InputFields<A extends KArgFields> = {
	[Key in keyof A]: A[Key] extends KType ? A[Key]['validator'] : A[Key]
}
type OutputFields<A extends KArgFields> = {
	[Key in keyof A]: A[Key] extends KType ? OutputNativeOf<A[Key]> : A[Key]
}
type Props<T> = T extends PropertyValidators ? T : never

/** Caller-facing args of an `args` declaration: a defaulted `k` field is optional, a transformed one has its input type. */
export type KArgsInput<A> = [A] extends [KObject<infer F>]
	? keyof F extends never
		? {}
		: A['_input']
	: [A] extends [VObject<any, any, any>]
		? A['type']
		: [A] extends [KArgFields]
			? ObjectType<Props<InputFields<A>>>
			: DefaultFunctionArgs

/** Handler-facing args of an `args` declaration: defaults filled and transforms applied. */
export type KArgsOutput<A> = [A] extends [KObject<any>]
	? A['_output']
	: [A] extends [VObject<any, any, any>]
		? A['type']
		: [A] extends [KArgFields]
			? ObjectType<Props<OutputFields<A>>>
			: DefaultFunctionArgs

type ReturnValueFor<R> = [R] extends [KType]
	? ValidatorTypeToReturnType<R['_output']>
	: [R] extends [GenericValidator]
		? ValidatorTypeToReturnType<Infer<R>>
		: any

type Expand<T> = { [Key in keyof T]: T[Key] }
type Overwrite<T, U> = keyof U extends never ? T : Omit<T, keyof U> & U
type ArgsForHandlerType<
	OneOrZeroArgs extends [] | [Record<string, any>],
	CustomMadeArgs extends Record<string, any>,
> =
	CustomMadeArgs extends Record<string, never>
		? OneOrZeroArgs
		: OneOrZeroArgs extends [infer A]
			? [Expand<A & CustomMadeArgs>]
			: [CustomMadeArgs]

type ReservedKey = 'args' | 'returns' | 'handler' | 'skipConvexValidation'

/**
 * A builder returned by `kCustomQuery`/`kCustomMutation`/`kCustomAction`. The handler receives the
 * output type of `args`; the registered function's reference exposes their input type.
 */
export type KCustomBuilder<
	FuncType extends 'query' | 'mutation' | 'action',
	CustomArgsValidator extends PropertyValidators,
	CustomCtx extends Record<string, any>,
	CustomMadeArgs extends Record<string, any>,
	InputCtx,
	Visibility extends FunctionVisibility,
	ExtraArgs extends Record<string, any>,
> = {
	<
		ArgsValidator extends KArgs | void = void,
		ReturnsValidator extends KReturns | void = void,
		ReturnValue extends ReturnValueFor<ReturnsValidator> = any,
	>(
		func:
			| ({
					args?: ArgsValidator
					returns?: ReturnsValidator
					/** Export no validators to Convex; the kit then parses args fully itself. */
					skipConvexValidation?: boolean
					handler: (
						ctx: Overwrite<InputCtx, CustomCtx>,
						...args: ArgsForHandlerType<[KArgsOutput<ArgsValidator>], CustomMadeArgs>
					) => ReturnValue
			  } & {
					[Key in keyof ExtraArgs as Key extends ReservedKey ? never : Key]: ExtraArgs[Key]
			  })
			| ((
					ctx: Overwrite<InputCtx, CustomCtx>,
					...args: ArgsForHandlerType<[KArgsOutput<ArgsValidator>], CustomMadeArgs>
			  ) => ReturnValue),
	): Registration<
		FuncType,
		Visibility,
		ArgsArrayToObject<
			CustomArgsValidator extends Record<string, never>
				? [KArgsInput<ArgsValidator>]
				: [Expand<KArgsInput<ArgsValidator> & ObjectType<CustomArgsValidator>>]
		>,
		ReturnValue
	>
}

/**
 * The ctx a handler registered through a `KCustomBuilder` receives, for helpers typed against one
 * builder (`type AuthCtx = KCustomCtx<typeof authQuery>`). Replaces convex-helpers' `ZCustomCtx`.
 */
export type KCustomCtx<Builder> = Builder extends (func: infer Func) => any
	? Extract<Func, (...args: any[]) => any> extends (ctx: infer Ctx, ...args: any[]) => any
		? Ctx
		: never
	: never

export function kCustomQuery<
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
	// SAFETY: the untyped builder implements exactly the contract KCustomBuilder declares.
	return customFnBuilder(query, customization, undefined) as KCustomBuilder<
		'query',
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		GenericQueryCtx<DataModel>,
		Visibility,
		ExtraArgs
	>
}

export function kCustomMutation<
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
	// SAFETY: the untyped builder implements exactly the contract KCustomBuilder declares.
	return customFnBuilder(mutation, customization, undefined) as KCustomBuilder<
		'mutation',
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		GenericMutationCtx<DataModel>,
		Visibility,
		ExtraArgs
	>
}

export function kCustomAction<
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
	// SAFETY: the untyped builder implements exactly the contract KCustomBuilder declares.
	return customFnBuilder(action, customization, undefined) as KCustomBuilder<
		'action',
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		GenericActionCtx<DataModel>,
		Visibility,
		ExtraArgs
	>
}

/** The kCustom* builders, with signatures identical to the module-level exports. */
export type KCustomFunctionBuilders = Readonly<{
	kCustomQuery: typeof kCustomQuery
	kCustomMutation: typeof kCustomMutation
	kCustomAction: typeof kCustomAction
}>

/** Registration options beyond the customization. */
export type KCustomFunctionOptions = Readonly<{
	/** How rejected arguments are thrown; defaults to `'validation'` (`KValidationError`). */
	argumentFailure?: ArgumentFailurePolicy
}>

/**
 * The kCustom* builders bound to registration options, e.g. an argument failure policy.
 * Signatures are identical to the module-level builders.
 */
export function kCustomFunctions(options?: KCustomFunctionOptions): KCustomFunctionBuilders {
	const reject = argumentRejecter(options?.argumentFailure)
	if (reject === undefined) return { kCustomQuery, kCustomMutation, kCustomAction }
	// SAFETY: identical boundary assertions as the module-level builders, with a bound rejecter.
	return {
		kCustomQuery: ((query: any, customization: any) =>
			customFnBuilder(query, customization, reject)) as typeof kCustomQuery,
		kCustomMutation: ((mutation: any, customization: any) =>
			customFnBuilder(mutation, customization, reject)) as typeof kCustomMutation,
		kCustomAction: ((action: any, customization: any) =>
			customFnBuilder(action, customization, reject)) as typeof kCustomAction,
	}
}

/** Raw function arguments, keyed by the native ctx of one invocation. */
const rawArguments = new WeakMap<object, DefaultFunctionArgs>()

/**
 * The raw arguments of the invocation that produced `ctx`, before the kit applied declared behaviour.
 * Available inside a customization `input` callback; empty for unknown contexts.
 */
export function rawFunctionArgs<DataModel extends GenericDataModel>(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel> | GenericActionCtx<DataModel>,
): DefaultFunctionArgs {
	return rawArguments.get(ctx) ?? {}
}

/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-reflect-get, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters -- Registration reads arbitrary user definition records by descriptor so declared accessors stay unread, and classifies undecoded user declarations. */
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
		// Define rather than assign, as object rest does, so a `__proto__` key stays an own property.
		Object.defineProperty(extra, key, {
			value: Reflect.get(definition, key),
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return extra
}

function isNative(value: unknown): value is GenericValidator {
	return (
		value !== null &&
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Declarations are classified by representation.
		typeof value === 'object' &&
		'isConvexValidator' in value &&
		value.isConvexValidator === true
	)
}

/**
 * Classify a declared `args` value without building anything: a `k.object`, a native object validator,
 * or a field object whose every value is a `k` schema or a native validator.
 */
function captureArgs(args: unknown): DeclaredArgs {
	if (args instanceof KObject) return { schema: args, native: undefined, fields: undefined }
	if (isNative(args)) {
		if (args.kind !== 'object' || args.isOptional !== 'required')
			throw new Error(`Unsupported args validator: v.${args.kind}; use an object`)
		return { schema: undefined, native: args, fields: undefined }
	}
	if (args instanceof KSchema)
		throw new Error(`Unsupported args schema: k.${rootOp(args)} chain; use a required k.object`)
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Declarations are classified by representation.
	if (args === null || typeof args !== 'object' || Array.isArray(args))
		throw new Error('Unsupported args validator: expected an object of fields')
	const fields: Record<string, KArgField> = {}
	for (const [key, field] of Object.entries(args)) {
		if (!(field instanceof KSchema) && !isNative(field))
			throw new Error(`Unsupported args field '${key}': expected a k schema or a native validator`)
		fields[key] = field
	}
	return { schema: undefined, native: undefined, fields }
}
/* oxlint-enable anti-slop/no-object-parameters, anti-slop/no-reflect-get, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters */

/** Exactly one member is set. */
type DeclaredArgs = {
	readonly schema: KObject<KFields> | undefined
	readonly native: GenericValidator | undefined
	readonly fields: Readonly<Record<string, KArgField>> | undefined
}

type ArgsRun = (args: DefaultFunctionArgs) => DefaultFunctionArgs

/** The per-function argument state, built once on first use. */
type ArgsState = {
	readonly keys: string[]
	/** Undefined when nothing is declared: the call path then does no validation work at all (R19). */
	readonly run: ArgsRun | undefined
	readonly boundary: FilterBoundary | undefined
}

/**
 * The compact filter boundary (U23): it replaces the exported args validator with one whose compact
 * filters are projected, and preflights raw args before customization. A projected filter is seen by
 * Convex as `any` below depth 1, so the preflight runs the full structural walker on it (KTD3).
 */
type FilterBoundary = {
	readonly validator: ObjectValidator
	preflight(args: DefaultFunctionArgs): void
}

function filterBoundary(declared: DeclaredArgs): FilterBoundary | undefined {
	if (declared.native) return undefined
	const fields = declared.schema ? declared.schema.shape : kFieldsOf(declared.fields ?? {}).kFields
	return compactArgumentBoundary(fields, () => nativeArgs(declared))
}

function rootOp(schema: KNode): string {
	let root = schema
	while (root.prev !== null) root = root.prev
	return root.op
}

function keysOf(declared: DeclaredArgs): string[] {
	if (declared.schema) return Object.keys(declared.schema.shape)
	if (declared.native) return Object.keys(nativeFields(declared.native))
	return Object.keys(declared.fields ?? {})
}

type ObjectValidator = VObject<any, PropertyValidators, 'required'>

function nativeObject(native: GenericValidator): ObjectValidator {
	// SAFETY: captureArgs only accepts required native validators of kind 'object'.
	return native as ObjectValidator
}

function nativeFields(native: GenericValidator): PropertyValidators {
	return nativeObject(native).fields
}

/** The input-side native validator Convex receives for the declared args. */
function nativeArgs(declared: DeclaredArgs): ObjectValidator {
	if (declared.schema) return declared.schema.validator
	if (declared.native) return nativeObject(declared.native)
	const fields: Record<string, GenericValidator> = {}
	for (const [key, field] of Object.entries(declared.fields ?? {}))
		fields[key] = field instanceof KSchema ? field.validator : nativeOf(field)
	return v.object(fields)
}

function nativeOf(field: KArgField): GenericValidator {
	// SAFETY: a field that is not a KSchema passed captureArgs as a native validator.
	return field as GenericValidator
}

/** The `k` fields of a field object, and whether native fields sit beside them. */
function kFieldsOf(fields: Readonly<Record<string, KArgField>>) {
	const kFields: Record<string, KType> = {}
	let mixed = false
	for (const [key, field] of Object.entries(fields)) {
		if (field instanceof KSchema) kFields[key] = field
		else mixed = true
	}
	return { kFields, mixed }
}

/** Plan-only run (KTD3): Convex already validated the structure, so only declared behaviour runs. */
function declaredRun(declared: DeclaredArgs): ArgsRun | undefined {
	if (declared.schema) {
		const schema = declared.schema
		return hasDeclaredBehaviour(schema) ? (args) => asArgs(runDeclared(schema, args)) : undefined
	}
	if (!declared.fields) return undefined
	const { kFields, mixed } = kFieldsOf(declared.fields)
	const schema = object(kFields)
	if (!hasDeclaredBehaviour(schema)) return undefined
	if (!mixed) return (args) => asArgs(runDeclared(schema, args))
	const kKeys = Object.keys(kFields)
	return (args) => merged(args, asArgs(runDeclared(schema, args)), kKeys)
}

/** Full run for `skipConvexValidation`: Convex validated nothing, so structure is checked here too. */
function fullRun(declared: DeclaredArgs): ArgsRun {
	if (declared.schema) {
		const schema = declared.schema
		return (args) => asArgs(schema.parse(args))
	}
	if (declared.native) {
		const native = declared.native
		return (args) => {
			if (!validate(native, args)) throw new KValidationError([structuralIssue([], native)])
			return args
		}
	}
	const fields = declared.fields ?? {}
	const { kFields, mixed } = kFieldsOf(fields)
	const schema = object(kFields)
	if (!mixed) return (args) => asArgs(schema.parse(args))
	const kKeys = Object.keys(kFields)
	return (args) => {
		const kValues: DefaultFunctionArgs = {}
		const issues: KIssue[] = []
		for (const key of Object.keys(args)) {
			const field = fields[key]
			if (field === undefined)
				issues.push({
					path: [key],
					code: 'unrecognized_key',
					message: `Unrecognized key: ${JSON.stringify(key)}`,
				})
			else if (field instanceof KSchema) kValues[key] = args[key]
			else if (!validate(nativeOf(field), args[key]))
				issues.push(structuralIssue([key], nativeOf(field)))
		}
		for (const [key, field] of Object.entries(fields)) {
			if (field instanceof KSchema || Object.hasOwn(args, key)) continue
			if (!validate(nativeOf(field), undefined))
				issues.push(structuralIssue([key], nativeOf(field)))
		}
		const parsed = schema.safeParse(kValues)
		if (!parsed.success) issues.push(...parsed.issues)
		if (issues.length > 0 || !parsed.success) throw new KValidationError(issues)
		return merged(args, asArgs(parsed.data), kKeys)
	}
}

function structuralIssue(path: (string | number)[], native: GenericValidator): KIssue {
	return { path, code: 'invalid_type', message: `Invalid input: expected ${native.kind}` }
}

/** Replace the `k` fields of `args` with their parsed values, keeping native fields untouched. */
function merged(
	args: DefaultFunctionArgs,
	parsed: DefaultFunctionArgs,
	kKeys: readonly string[],
): DefaultFunctionArgs {
	if (parsed === args) return args
	const out: DefaultFunctionArgs = { ...args }
	for (const key of kKeys) {
		if (Object.hasOwn(parsed, key)) out[key] = parsed[key]
		else delete out[key]
	}
	return out
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The walker hands back the parsed args object it was given.
function asArgs(value: unknown): DefaultFunctionArgs {
	// SAFETY: an object schema's parse of an args object yields an args object.
	return value as DefaultFunctionArgs
}

/** The native `returns` validator Convex receives: the output side of a `k` schema. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Declarations are classified by representation.
function nativeReturns(returns: unknown): GenericValidator {
	if (returns instanceof KSchema) {
		const path = transformPath(returns)
		if (path !== undefined)
			throw new Error(
				`A returns schema cannot transform: the kit does not run return transforms (${path ? `field '${path}'` : 'the schema'} uses transform or pipe). Declare returns with the output type, e.g. schema.omit('field').extend({ field: k.string() })`,
			)
		return returns.outputValidator
	}
	if (isNative(returns)) return returns
	throw new Error('Unsupported returns validator: expected a k schema or a native validator')
}

function hasFields(value: DefaultFunctionArgs | undefined): boolean {
	return value !== undefined && Object.keys(value).length > 0
}

function customFnBuilder(
	builder: (args: any) => any,
	customization: Customization<any, any, any, any, any>,
	reject: ArgumentRejecter | undefined,
) {
	const customInput: Customization<any, any, any, any, any>['input'] =
		customization.input ?? NoOp.input
	const inputArgs: PropertyValidators = customization.args ?? NoOp.args
	const inputKeys = Object.keys(inputArgs)
	return function customBuilder(fn: any): any {
		// Descriptor reads keep getter-declared args/returns unread until Convex or a call needs them.
		const handler = fn.handler === undefined ? fn : fn.handler
		const skipConvexValidation =
			fn.skipConvexValidation === undefined ? false : fn.skipConvexValidation
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Builders accept a bare handler function or a definition object.
		const extra = typeof fn === 'object' && fn !== null ? extraOptions(fn) : {}
		const declaredArgs = presence(fn, 'args')
		const declaredReturns = presence(fn, 'returns')
		const returnsValidator = memoize(() => nativeReturns(declaredReturns.read()))

		const nativeDefinition = (handle: (ctx: any, args: any) => Promise<any>) => {
			// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- The native definition carries opaque validators and the handler.
			const native: Record<string, unknown> = {}
			if (declaredReturns.present && !skipConvexValidation)
				Object.defineProperty(native, 'returns', { enumerable: true, get: returnsValidator })
			native.handler = handle
			return native
		}

		const finish = async (ctx: any, args: any, added: any) => {
			const finalCtx = { ...ctx, ...added.ctx }
			// No made args: the handler receives the args object itself, untouched.
			const finalArgs = hasFields(added.args) ? { ...args, ...added.args } : args
			const result = await handler(finalCtx, finalArgs)
			if (added.onSuccess) await added.onSuccess({ ctx, args, result })
			return result
		}

		if (declaredArgs.present) {
			// Data-declared args are classified now, as registration always did; nothing is built.
			const captured = declaredArgs.data ? captureArgs(declaredArgs.read()) : undefined
			const declaration = memoize(() => captured ?? captureArgs(declaredArgs.read()))
			const argsState = memoize((): ArgsState => {
				const current = declaration()
				return {
					keys: keysOf(current),
					run: skipConvexValidation ? fullRun(current) : declaredRun(current),
					boundary: skipConvexValidation ? undefined : filterBoundary(current),
				}
			})
			const argsValidator = memoize(() => {
				const boundary = argsState().boundary
				return addFieldsToValidator(boundary?.validator ?? nativeArgs(declaration()), inputArgs)
			})
			// Convex validates nothing when skipped, so customization args are checked before input runs.
			const customRun =
				skipConvexValidation && inputKeys.length > 0
					? memoize(() => fullRun({ schema: undefined, native: undefined, fields: inputArgs }))
					: undefined
			const native = nativeDefinition(async (ctx: any, allArgs: any) => {
				const { keys, run, boundary } = argsState()
				if (boundary) rejecting(reject, 'filter', () => boundary.preflight(allArgs))
				rawArguments.set(ctx, allArgs)
				const customArgs = inputKeys.length === 0 ? {} : pick(allArgs, inputKeys)
				const added = await customInput(
					ctx,
					customRun === undefined
						? customArgs
						: rejecting(reject, 'arguments', () => customRun()(customArgs)),
					extra,
				)
				const declaredValues = inputKeys.length === 0 ? allArgs : pick(allArgs, keys)
				return finish(
					ctx,
					run === undefined
						? declaredValues
						: rejecting(reject, 'arguments', () => run(declaredValues)),
					added,
				)
			})
			if (skipConvexValidation) native.args = undefined
			else Object.defineProperty(native, 'args', { enumerable: true, get: argsValidator })
			return builder(native)
		}
		if (skipConvexValidation && inputKeys.length > 0) {
			throw new Error(
				"If you're using a custom function with arguments for the input " +
					'customization, you cannot skip convex validation.',
			)
		}
		return builder(
			nativeDefinition(async (ctx: any, args: any) => {
				rawArguments.set(ctx, args)
				return finish(ctx, args, await customInput(ctx, args, extra))
			}),
		)
	}
}

/** Maps a kit validation failure to what the app's argument failure policy throws. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- The app hook returns an arbitrary throwable.
type ArgumentRejecter = (source: ArgumentFailure['source'], issues: readonly KIssue[]) => unknown

/** Resolved once per builder family; undefined keeps `KValidationError` and adds nothing to a call. */
function argumentRejecter(policy: ArgumentFailurePolicy | undefined): ArgumentRejecter | undefined {
	if (policy === undefined || policy === 'validation') return undefined
	// oxlint-disable-next-line anti-slop/no-unknown-returns -- The app hook returns an arbitrary throwable.
	const toThrown: (failure: ArgumentFailure) => unknown =
		policy === 'declared'
			? (failure) =>
					argumentErrors.toConvexError('INVALID_ARGUMENTS', { issues: [...failure.issues] })
			: policy
	return (source, issues) =>
		toThrown(Object.freeze({ source, issues: sanitizeArgumentIssues(issues) }))
}

/** Run one validation step; with a policy, a `KValidationError` it raises is rethrown as the policy's value. */
function rejecting<T>(
	reject: ArgumentRejecter | undefined,
	source: ArgumentFailure['source'],
	step: () => T,
): T {
	if (reject === undefined) return step()
	try {
		return step()
	} catch (error) {
		if (error instanceof KValidationError) throw reject(source, error.data.issues)
		throw error
	}
}
