/**
 * Zod interop: `toZod()` as a function, and as a method that importing this entry installs on
 * every `k` schema. Schemas are built with `zod/mini`, so the entry bundles Zod's core and the few
 * constructors used here. A caller may inject classic Zod for its method API. A result feeds any library
 * that accepts a Zod 4 schema, and is extended with `zod/mini` functions. Core declarations never mention Zod; the method's type comes from the global
 * `CvxKitSchemaMethods` augmentation below, so only apps that import `cvx-kit/zod` see it. (A module
 * augmentation of `./k/schema` would not resolve from the built `.d.mts` files.)
 */
import type * as classic from 'zod'
import * as z from 'zod/mini'
import { membersOf } from './k/compile'
import { emailPattern, isUrl, KConversionFailure, maxTimestamp } from './k/formats'
import { NEVER } from './k/issues'
import { setOwn } from './k/names'
import { containsTransform } from './k/parse'
import { KSchema, type KCheckContext } from './k/schema'
import type {
	KDiscriminated,
	KFields,
	KFormat,
	KLiteralValue,
	KMessage,
	KNode,
	KType,
} from './k/types'

/** The converted schema preserves the kit schema's parsed output and accepted input types. */
export type KZod<S extends KType> = z.ZodMiniType<S['_output'], S['validator']['type']>

/** A converted classic Zod schema with chain methods. */
export type KClassicZod<S extends KType> = classic.ZodType<S['_output'], S['validator']['type']>

/** Metadata `toZod` records on every converted `k.id`: the table the id belongs to. */
export type KZodIdMeta = { tableName: string }

/**
 * The registry holding {@link KZodIdMeta} for converted ids: `kZodIds.get(schema)?.tableName` reads
 * which table an id schema belongs to. An id converts to a plain `z.string()` (it parses exactly as
 * `k.id` does), so libraries that convert Zod to Convex validators see a string, not an id.
 */
export const kZodIds = z.registry<KZodIdMeta>()

declare global {
	interface CvxKitSchemaMethods {
		/** Convert to Zod 4; see {@link toZod}. Installed by importing `cvx-kit/zod`. */
		toZod<S extends KType>(this: S): KZod<S>
	}
}

/**
 * Convert a kit schema to Zod Mini, or to classic Zod using the caller's namespace.
 * Structure, normalisers, checks, transforms, pipes, defaults and descriptions are carried.
 * Ids retain their table typing and record their table in {@link kZodIds}.
 * `k.jsonObject()` checks Convex's key rule on top-level keys only. A schema holding `catch` throws.
 */
export function toZod<S extends KType>(schema: S): KZod<S>
/**
 * @deprecated Import `toZod` from `cvx-kit/zod/classic` instead.
 * Passing the namespace keeps all of Zod in the bundle.
 */
export function toZod<S extends KType>(
	schema: S,
	options: { zod: typeof classic.z },
): KClassicZod<S>
/**
 * @deprecated Import `toZod` from `cvx-kit/zod/classic` for classic output.
 * Passing the namespace keeps all of Zod in the bundle.
 */
export function toZod<S extends KType>(
	schema: S,
	options: { zod: typeof classic.z } | undefined,
): KZod<S> | KClassicZod<S>
export function toZod<S extends KType>(
	schema: S,
	options?: { zod: typeof classic.z },
): KZod<S> | KClassicZod<S> {
	// SAFETY: both namespaces implement these functional constructors over the same Zod core.
	const factory = options === undefined ? miniFunctions : retyped<Factory>(options.zod)
	// SAFETY: conversion preserves input/output types; the injected factory determines the method API.
	return retyped<KZod<S> | KClassicZod<S>>(convert(schema, factory))
}

/** @internal Shared converter bridge for the named classic constructor table. */
// oxlint-disable-next-line anti-slop/no-object-parameters -- the classic constructor table shares Mini signatures at runtime, but its method interfaces differ.
export function toZodWithFactory<S extends KType>(schema: S, factory: object): KClassicZod<S> {
	// SAFETY: Mini and classic functional constructors implement the same Zod core operations.
	return retyped<KClassicZod<S>>(convert(schema, retyped<Factory>(factory)))
}

Object.defineProperty(KSchema.prototype, 'toZod', {
	value: toZodMethod,
	writable: true,
	configurable: true,
})

// Keep named function references: using the namespace as a value retains every Mini export and locale.
const miniFunctions = {
	string: z.string,
	number: z.number,
	int: z.int,
	bigint: z.bigint,
	boolean: z.boolean,
	null: z.null,
	undefined: z.undefined,
	instanceof: z.instanceof,
	any: z.any,
	json: z.json,
	record: z.record,
	literal: z.literal,
	enum: z.enum,
	array: z.array,
	object: z.object,
	looseObject: z.looseObject,
	strictObject: z.strictObject,
	union: z.union,
	discriminatedUnion: z.discriminatedUnion,
	optional: z.optional,
	nullable: z.nullable,
	prefault: z.prefault,
	_default: z._default,
	describe: z.describe,
	iso: { date: z.iso.date, datetime: z.iso.datetime },
	gte: z.gte,
	lte: z.lte,
	gt: z.gt,
	lt: z.lt,
	minLength: z.minLength,
	maxLength: z.maxLength,
	length: z.length,
	regex: z.regex,
	refine: z.refine,
	trim: z.trim,
	toLowerCase: z.toLowerCase,
	toUpperCase: z.toUpperCase,
	check: z.check,
	transform: z.transform,
	pipe: z.pipe,
}
type Factory = typeof miniFunctions

function toZodMethod(this: KType): Mini {
	return convert(this, miniFunctions)
}

type Mini = z.ZodMiniType

function convert(node: KNode, z: Factory): Mini {
	const records: KNode[] = []
	for (let current: KNode | null = node; current !== null; current = current.prev)
		records.push(current)
	// SAFETY: a chain always ends at a root record.
	const root = records.pop() as KNode
	let out = rootSchema(root, policyOf(records), z)
	const partialAt = records.findIndex(isPartial)
	let transformed = containsTransform(root)
	let description: string | undefined
	let run: KNode[] = []
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]
		if (isRunOp(record)) {
			run.push(record)
			continue
		}
		if (record.op === 'describe') {
			description = textOf(record)
			continue
		}
		out = applyRun(out, run, z)
		run = []
		switch (record.op) {
			case 'transform':
				out = z.pipe(
					out,
					z.transform((value, payload) =>
						callbackResult(callbackOf(record)(value, checkContext(payload)), payload, 'transform'),
					),
				)
				transformed = true
				break
			case 'pipe':
				// SAFETY: a pipe stores its target schema.
				out = z.pipe(out, convert(record.arg as KType, z))
				transformed = true
				break
			case 'optional':
				if (hiddenDefaultBelow(record.prev)) {
					// This freshly converted chain belongs only to this optional. A default hidden
					// behind a pipe must not advertise substitution to Zod's optional parser.
					Object.defineProperty(out._zod, 'optin', { value: 'optional', configurable: true })
				}
				out = z.optional(out)
				break
			case 'partial':
				out = z.optional(out)
				break
			case 'nullable':
				out = z.nullable(out)
				break
			case 'catch':
				// z.catch adds about 10 KB of zod/mini core to every bundle importing this entry.
				throw new Error(
					'toZod: .catch() is not carried; convert the wrapped schema and add z.catch yourself',
				)
			case 'default':
				if (!(partialAt >= 0 && index > partialAt)) out = withDefault(out, record, transformed, z)
				break
			default:
				break
		}
	}
	out = applyRun(out, run, z)
	return description === undefined ? out : out.check(z.describe(description))
}

/** Convex's field-name rule (`isFieldName`): 1 to 1024 printable ASCII characters, the first not `$`. */
const fieldName = /^[ -#%-~][ -~]{0,1023}$/

function rootSchema(root: KNode, policy: 'strip' | 'strict' | 'loose', z: Factory): Mini {
	switch (root.op) {
		case 'string':
			return z.string()
		case 'isoDate':
			return z.iso.date()
		case 'isoDateTime':
			return z.iso.datetime({ offset: true })
		case 'id':
			// SAFETY: k.id stores its table name as the root argument.
			return z.string().register(kZodIds, { tableName: root.arg as string })
		case 'number':
			return z.number()
		case 'int':
			return z.int()
		case 'timestamp':
			return z.int().check(z.gte(0), z.lte(maxTimestamp))
		case 'int64':
			return z.bigint()
		case 'boolean':
			return z.boolean()
		case 'void':
			return z.union([z.null(), z.undefined()])
		case 'null':
			return z.null()
		case 'bytes':
			return z.instanceof(ArrayBuffer)
		case 'any':
			return z.any()
		case 'json':
			return z.json()
		case 'jsonObject':
			// Top-level keys follow Convex's field-name rule; nested keys are not checked (see toZod).
			return z.record(z.string().check(z.regex(fieldName)), z.json())
		case 'literal':
			// SAFETY: k.literal stores its value as the root argument.
			return z.literal(root.arg as KLiteralValue)
		case 'enum':
			// SAFETY: k.enum stores its non-empty value list as the root argument.
			return z.enum(root.arg as readonly [string, ...string[]])
		case 'array':
			// SAFETY: k.array stores its element schema as the root argument.
			return z.array(convert(root.arg as KType, z))
		case 'object': {
			// SAFETY: k.object stores its field map as the root argument.
			const fields = root.arg as KFields
			const converted: Record<string, Mini> = {}
			for (const key in fields) setOwn(converted, key, convert(fields[key], z))
			if (policy === 'loose') return z.looseObject(converted)
			return policy === 'strict' ? z.strictObject(converted) : z.object(converted)
		}
		case 'record': {
			// SAFETY: k.record stores its key and value schemas as the root argument.
			const [key, value] = root.arg as readonly KType[]
			// SAFETY: record keys are k.string() or k.id(), which convert to Zod record keys.
			return z.record(convert(key, z) as z.ZodMiniString, convert(value, z))
		}
		case 'union':
			return z.union(membersOf(root).map((member) => convert(member, z)))
		case 'discriminatedUnion': {
			// SAFETY: k.discriminatedUnion stores its key and object options as the root argument.
			const { key, options } = root.arg as KDiscriminated
			// SAFETY: each option is a k.object, which converts to a Zod object.
			const objects = options.map((member) => convert(member, z)) as [
				z.ZodMiniObject,
				...z.ZodMiniObject[],
			]
			return z.discriminatedUnion(key, objects)
		}
		default:
			throw new Error(`toZod: '${root.op}' is not a root operation`)
	}
}

/** Keep checks on the base type, but skip the whole run if its wrapped base failed. */
function applyRun(base: Mini, run: readonly KNode[], z: Factory): Mini {
	if (run.length === 0) return base
	const kind = kindOf(base)
	const enabled = new WeakSet<z.core.ParsePayload>()
	const gate = z.check((payload) => {
		if (payload.issues.length === 0) enabled.add(payload)
		else enabled.delete(payload)
	})
	let out = base.check(gate)
	for (const record of run) if (isNormaliser(record)) out = applyNormaliser(out, record, kind, z)
	for (const record of run) if (!isNormaliser(record)) out = applyCheck(out, record, kind, z)
	const checks = out._zod.def.checks ?? []
	for (const check of checks.slice((base._zod.def.checks?.length ?? 0) + 1)) {
		const when = check._zod.def.when
		check._zod.def.when = (payload) => enabled.has(payload) && (when?.(payload) ?? true)
	}
	return out
}

/** The Zod definition kind: a string format is a `string`, a number format a `number`. */
function kindOf(schema: Mini): string {
	return schema._zod.def.type
}

function applyNormaliser(base: Mini, record: KNode, kind: string, z: Factory): Mini {
	if (record.op === 'overwrite')
		return base.check(
			z.check((payload) => {
				payload.value = callbackResult(callbackOf(record)(payload.value), payload, 'overwrite')
			}),
		)
	if (kind !== 'string') return base
	if (record.op === 'trim') return base.check(z.trim())
	if (record.op === 'lower') return base.check(z.toLowerCase())
	if (record.op === 'upper') return base.check(z.toUpperCase())
	return base
}

function applyCheck(base: Mini, record: KNode, kind: string, z: Factory): Mini {
	if (record.op === 'refine') {
		const options = { message: messageOf(record.message), path: pathOf(record.message) }
		return base.check(z.refine((value) => settled(callbackOf(record)(value)) === true, options))
	}
	if (record.op === 'check')
		return base.check(
			z.check((payload) => {
				const context = checkContext(payload)
				if (isThenable(settled(callbackOf(record)(payload.value, context))))
					context.addIssue({ message: 'A check must be synchronous' })
			}),
		)
	const message = messageOf(record.message)
	if (record.op === 'regex') {
		// SAFETY: .regex stores its pattern as the record argument.
		const pattern = record.arg as RegExp
		return kind === 'string' ? base.check(z.regex(pattern, message)) : base
	}
	if (record.op === 'format') {
		if (kind !== 'string') return base
		// SAFETY: .email and .url store their format as the record argument.
		const format = record.arg as KFormat
		if (format.kind === 'email')
			return base.check(z.regex(emailPattern, message ?? 'Invalid email address'))
		return base.check(
			// SAFETY: the base is a string schema, so the refinement receives a string.
			z.refine(
				(value) => isUrl(value as string, format.protocol, format.hostname),
				message ?? 'Invalid URL',
			),
		)
	}
	if (record.op === 'int') return kind === 'number' ? base.check(z.int(message)) : base
	if ((kind === 'number' || kind === 'bigint') && (record.op === 'gt' || record.op === 'lt')) {
		// SAFETY: gt and lt store their limit (a bigint on k.int64) as the record argument.
		const bound = record.arg as number | bigint
		return base.check(record.op === 'gt' ? z.gt(bound, message) : z.lt(bound, message))
	}
	if (kind === 'number' && record.op === 'safe')
		return base.check(
			z.int(message),
			z.gte(Number.MIN_SAFE_INTEGER, message),
			z.lte(Number.MAX_SAFE_INTEGER, message),
		)
	// `finite` needs no check: Zod's number already rejects NaN and the infinities.
	if (record.op !== 'min' && record.op !== 'max' && record.op !== 'length') return base
	// SAFETY: min, max and length store their numeric limit as the record argument.
	const limit = record.arg as number
	if (kind === 'string' || kind === 'array') {
		if (record.op === 'min') return base.check(z.minLength(limit, message))
		if (record.op === 'max') return base.check(z.maxLength(limit, message))
		return base.check(z.length(limit, message))
	}
	if (kind === 'number' || kind === 'bigint') {
		// SAFETY: on k.int64 the stored limit is a bigint, which Zod's numeric bounds accept.
		const bound = record.arg as number | bigint
		if (record.op === 'min') return base.check(z.gte(bound, message))
		if (record.op === 'max') return base.check(z.lte(bound, message))
	}
	return base
}

/**
 * A default feeds the wrapped chain unless that chain transforms; then it supplies parsed output.
 */
function withDefault(base: Mini, record: KNode, transformed: boolean, z: Factory): Mini {
	if (record.arg === undefined) {
		if (!transformed) return base
		// An undefined output default only short-circuits absent input; do not serialize it.
		Object.defineProperty(base._zod, 'optin', { value: 'optional', configurable: true })
		return z.optional(base)
	}
	// SAFETY: the default's type is the chain's input, or its output when a transform sits below it.
	return transformed ? z._default(base, record.arg as never) : z.prefault(base, record.arg as never)
}

function messageOf(message: KMessage): string | undefined {
	if (message === undefined) return undefined
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- refine stores either its message or its options object.
	return typeof message === 'string' ? message : message.message
}

function isRunOp(record: KNode): boolean {
	switch (record.op) {
		case 'min':
		case 'max':
		case 'length':
		case 'regex':
		case 'format':
		case 'int':
		case 'gt':
		case 'lt':
		case 'finite':
		case 'safe':
		case 'trim':
		case 'lower':
		case 'upper':
		case 'refine':
		case 'check':
		case 'overwrite':
			return true
		default:
			return false
	}
}

function isNormaliser(record: KNode): boolean {
	return (
		record.op === 'trim' ||
		record.op === 'lower' ||
		record.op === 'upper' ||
		record.op === 'overwrite'
	)
}

/** A `partial()` field is optional and never receives the default declared below it. */
function isPartial(record: KNode): boolean {
	return record.op === 'partial'
}

/** A visible default substitutes; only a default hidden by a transform/pipe must be skipped. */
function hiddenDefaultBelow(node: KNode | null): boolean {
	let hidden = false
	for (let current = node; current !== null; current = current.prev) {
		if (current.op === 'default') return hidden
		if (current.op === 'transform' || current.op === 'pipe') hidden = true
	}
	return false
}

/** The unknown-key policy of a chain given outermost record first: the last one declared, or strip. */
function policyOf(records: readonly KNode[]): 'strip' | 'strict' | 'loose' {
	for (const record of records)
		if (record.op === 'strip' || record.op === 'strict' || record.op === 'loose') return record.op
	return 'strip'
}

function textOf(record: KNode): string {
	// SAFETY: a describe record stores its text as the record argument.
	return record.arg as string
}

function checkContext(payload: z.core.ParsePayload, continuable = true): KCheckContext {
	return {
		addIssue(issue) {
			// SAFETY: kit issues carry explicit messages; Zod does not need its code-specific error-map fields.
			payload.issues.push(
				retyped<z.core.$ZodRawIssue>({
					...issue,
					code: issue.code ?? 'custom',
					path: issue.path === undefined ? [] : [...issue.path],
					input: payload.value,
					continue: continuable,
				}),
			)
		},
	}
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- callbacks accept the preceding schema's parsed value; each chain can change its type.
type Callback = (value: unknown, context?: KCheckContext) => unknown

function callbackOf(record: KNode): Callback {
	// SAFETY: refine, check, overwrite and transform records store their declared callback.
	return retyped<Callback>(record.arg)
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- bridges the shared Zod core across Mini and classic method interfaces.
function retyped<T>(value: unknown): T {
	// SAFETY: callers document the structural compatibility they have established.
	return value as T
}

function pathOf(message: KMessage): PropertyKey[] | undefined {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- refine accepts either a message string or options with a relative path.
	if (message === undefined || typeof message === 'string' || message.path === undefined)
		return undefined
	return [...message.path]
}

/** Preserve the kit's synchronous callback and conversion-failure contracts in Zod's payload. */
function callbackResult<T>(
	value: T,
	payload: z.core.ParsePayload,
	kind: 'transform' | 'overwrite',
): T {
	settled(value)
	if (payload.issues.length > 0) return NEVER
	const context = checkContext(payload, false)
	if (value instanceof KConversionFailure)
		context.addIssue({ code: 'invalid_value', message: value.message })
	else if (value === NEVER) context.addIssue({ message: 'Invalid input' })
	else if (isThenable(value))
		context.addIssue({
			message: `Async ${kind} is not supported: ${kind} callbacks must be synchronous`,
		})
	return payload.issues.length > 0 ? NEVER : value
}

function settled<T>(value: T): T {
	if (isThenable(value)) value.then(undefined, () => {})
	return value
}

/* oxlint-disable anti-slop/no-runtime-typeof -- promise-like callbacks must be rejected and their rejection contained, as in the kit parser. */
function isThenable<T>(value: T): value is T & PromiseLike<unknown> {
	return (
		value !== null &&
		(typeof value === 'object' || typeof value === 'function') &&
		'then' in value &&
		typeof value.then === 'function'
	)
}
/* oxlint-enable anti-slop/no-runtime-typeof */
