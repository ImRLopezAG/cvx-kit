import { v } from 'convex/values'
import type {
	GenericId,
	JSONValue,
	VAny,
	VArray,
	VBoolean,
	VBytes,
	VFloat64,
	VId,
	VInt64,
	VLiteral,
	VNull,
	VRecord,
	VString,
	VUnion,
} from 'convex/values'
import { discriminatorDispatch } from './dispatch'
import { checkMessage } from './messages'
import { setOwn } from './names'
import { assertSchema, KSchema } from './schema'
import type { KSafeParseResult } from './issues'
import type {
	KCheckMessage,
	KDiscriminated,
	KFormat,
	KLiteralValue,
	KNode,
	KOutputRequired,
	KRefineOptions,
	KType,
	KTupleArg,
	KUrlOptions,
} from './types'

export class KString extends KSchema<string, VString<string>> {
	min(length: number, message?: KCheckMessage): this {
		return this.link('min', numberBound(length), checkMessage(message, 'min'))
	}

	max(length: number, message?: KCheckMessage): this {
		return this.link('max', numberBound(length), checkMessage(message, 'max'))
	}

	length(length: number, message?: KCheckMessage): this {
		return this.link('length', numberBound(length), checkMessage(message, 'length'))
	}

	regex(pattern: RegExp, message?: KCheckMessage): this {
		return this.link('regex', pattern, checkMessage(message, 'regex'))
	}

	/** An email address (Zod 4's pattern); issue `invalid_format`. */
	email(message?: KCheckMessage): this {
		return this.link('format', emailFormat, checkMessage(message, 'email'))
	}

	/**
	 * A URL the WHATWG parser accepts; `protocol` and `hostname` patterns narrow it
	 * (`k.url({ protocol: /^https$/ })`). Issue `invalid_format`.
	 */
	url(options?: string | KUrlOptions): this {
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- a check takes either its message or an options object.
		const patterns = options === undefined || typeof options === 'string' ? undefined : options
		return this.link(
			'format',
			Object.freeze({
				kind: 'url' as const,
				protocol: patterns?.protocol,
				hostname: patterns?.hostname,
			}),
			checkMessage(options, 'url'),
		)
	}

	ipv4(message?: KCheckMessage): this {
		return this.link('format', ipv4Format, checkMessage(message, 'ipv4'))
	}

	ipv6(message?: KCheckMessage): this {
		return this.link('format', ipv6Format, checkMessage(message, 'ipv6'))
	}

	uuid(message?: KCheckMessage): this {
		return this.link('format', uuidFormat, checkMessage(message, 'uuid'))
	}

	trim(): this {
		return this.link('trim', undefined, undefined)
	}

	toLowerCase(): this {
		return this.link('lower', undefined, undefined)
	}

	toUpperCase(): this {
		return this.link('upper', undefined, undefined)
	}
}

export class KNumber extends KSchema<number, VFloat64<number>> {
	min(value: number, message?: KCheckMessage): this {
		return this.link('min', numberBound(value), checkMessage(message, 'min'))
	}

	max(value: number, message?: KCheckMessage): this {
		return this.link('max', numberBound(value), checkMessage(message, 'max'))
	}

	gt(value: number, message?: KCheckMessage): this {
		return this.link('gt', numberBound(value), checkMessage(message, 'gt'))
	}

	lt(value: number, message?: KCheckMessage): this {
		return this.link('lt', numberBound(value), checkMessage(message, 'lt'))
	}

	multipleOf(divisor: number, message?: KCheckMessage): this {
		if (!(divisor > 0) || !Number.isFinite(divisor))
			throw new TypeError('k.number().multipleOf() expects a positive finite divisor')
		return this.link('multipleOf', divisor, checkMessage(message, 'multipleOf'))
	}

	int(message?: KCheckMessage): this {
		return this.link('int', undefined, checkMessage(message, 'int'))
	}

	/** `> 0`; issue `too_small`. */
	positive(message?: KCheckMessage): this {
		return this.link('gt', 0, checkMessage(message, 'positive'))
	}

	/** `>= 0`, the same check as `.min(0)`. */
	nonnegative(message?: KCheckMessage): this {
		return this.link('min', 0, checkMessage(message, 'nonnegative'))
	}

	/** `< 0`; issue `too_big`. */
	negative(message?: KCheckMessage): this {
		return this.link('lt', 0, checkMessage(message, 'negative'))
	}

	/** `<= 0`, the same check as `.max(0)`. */
	nonpositive(message?: KCheckMessage): this {
		return this.link('max', 0, checkMessage(message, 'nonpositive'))
	}

	/** Rejects `NaN` and the infinities, which a bare `k.number()` accepts; issue `invalid_type`. */
	finite(message?: KCheckMessage): this {
		return this.link('finite', undefined, checkMessage(message, 'finite'))
	}

	/**
	 * A safe integer (`Number.isSafeInteger`): `not_integer`, or `too_small`/`too_big` outside the range.
	 * `k.int()` and `.int()` already check this, so on an integer it only attaches a message.
	 */
	safe(message?: KCheckMessage): this {
		return this.link('safe', undefined, checkMessage(message, 'safe'))
	}
}

export class KInt64 extends KSchema<bigint, VInt64<bigint>> {
	min(value: bigint, message?: KCheckMessage): this {
		return this.link('min', int64Bound(value), checkMessage(message, 'min'))
	}

	max(value: bigint, message?: KCheckMessage): this {
		return this.link('max', int64Bound(value), checkMessage(message, 'max'))
	}

	/** `> 0n`; issue `too_small`. */
	positive(message?: KCheckMessage): this {
		return this.link('gt', 0n, checkMessage(message, 'positive'))
	}

	/** `>= 0n`, the same check as `.min(0n)`. */
	nonnegative(message?: KCheckMessage): this {
		return this.link('min', 0n, checkMessage(message, 'nonnegative'))
	}

	/** `< 0n`; issue `too_big`. */
	negative(message?: KCheckMessage): this {
		return this.link('lt', 0n, checkMessage(message, 'negative'))
	}

	/** `<= 0n`, the same check as `.max(0n)`. */
	nonpositive(message?: KCheckMessage): this {
		return this.link('max', 0n, checkMessage(message, 'nonpositive'))
	}
}

export class KNever extends KSchema<never, VUnion<never, []>> {}

export class KBoolean extends KSchema<boolean, VBoolean<boolean>> {}

export class KNull extends KSchema<null, VNull<null>> {}

/** Return declarations only: Convex serializes a missing handler result as null. */
export class KVoid extends KSchema<null | undefined, VNull<null>> {
	declare readonly _void: true

	/** Contract boundaries use the same null wire result as Convex registration. */
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Contract results are undecoded handler values.
	override '~safeParseStrict'(input: unknown): KSafeParseResult<null> {
		const parsed = super['~safeParseStrict'](input)
		return parsed.success ? { success: true, data: parsed.data ?? null } : parsed
	}
}

export class KBytes extends KSchema<ArrayBuffer, VBytes<ArrayBuffer>> {}

export class KAny extends KSchema<any, VAny> {}

/**
 * Any JSON-compatible value. Natively the six-member union v1's `z.json()` stored (string, number,
 * boolean, null, array of any, record of any); parse also checks the value is JSON-compatible throughout.
 */
export class KJson extends KSchema<
	JSONValue,
	VUnion<
		JSONValue,
		[
			VString<string>,
			VFloat64<number>,
			VBoolean<boolean>,
			VNull<null>,
			VArray<JSONValue[], VAny<JSONValue>>,
			VRecord<Record<string, JSONValue>, VString<string>, VAny<JSONValue>>,
		]
	>
> {}

export class KLiteral<V extends KLiteralValue> extends KSchema<V, VLiteral<V>> {}

export class KEnum<V extends readonly string[]> extends KSchema<
	V[number],
	VUnion<V[number], { -readonly [I in keyof V]: VLiteral<V[I]> }>
> {
	get options(): V {
		// SAFETY: k.enum stores its string array or tuple as the root argument.
		return rootOf(this).arg as V
	}

	/** The values as a value-to-value record, as Zod's `.enum`. */
	get enum(): { readonly [Value in V[number]]: Value } {
		const out: Record<string, string> = {}
		for (const value of this.options) setOwn(out, value, value)
		// SAFETY: every value maps to itself, which is the record type declared.
		return Object.freeze(out) as { readonly [Value in V[number]]: Value }
	}

	/** A new enum without `values`, in this enum's order; checks declared on this enum are not carried over. */
	exclude<const E extends readonly V[number][]>(
		values: E,
	): KEnum<KEnumValues<Exclude<V[number], E[number]>>> {
		const dropped = new Set<string>(values)
		return enumValues<KEnumValues<Exclude<V[number], E[number]>>>(
			this.options.filter((value) => !dropped.has(value)),
		)
	}

	/** A new enum with only `values`, in the order given; checks declared on this enum are not carried over. */
	extract<const E extends readonly [V[number], ...V[number][]]>(values: E): KEnum<E> {
		const unknown = values.find((value) => !this.options.includes(value))
		if (unknown !== undefined) throw new Error(`k.enum().extract(): "${unknown}" is not a value`)
		// In the requested order, as Zod 4's `extract`, so `.options` matches the declared tuple.
		return enumValues<E>([...new Set<string>(values)])
	}
}

/** The value tuple of a derived enum: a union of string values. */
export type KEnumValues<U extends string> = [U, ...U[]]

export class KId<T extends string> extends KSchema<GenericId<T>, VId<GenericId<T>>> {
	/** Rejected: only Convex can check an id's table, and `.catch` replaces Convex's check with `v.any()`. */
	override catch(fallback: never): never {
		super.catch(fallback)
		throw new Error('k: .catch() cannot wrap k.id')
	}
}

export class KArray<E extends KType> extends KSchema<
	E['_output'][],
	VArray<E['_req']['type'][], E['_req']>,
	E['_d'],
	VArray<E['_req']['type'][], E['_req']>,
	E['_t']
> {
	declare readonly _or: VArray<E['_output'][], KOutputRequired<E>>
	declare readonly _oo: VArray<E['_output'][], KOutputRequired<E>>

	/** The element schema. */
	get element(): E {
		// SAFETY: k.array stores its element schema as the root argument.
		return rootOf(this).arg as E
	}

	min(length: number, message?: KCheckMessage): this {
		return this.link('min', numberBound(length), checkMessage(message, 'min'))
	}

	max(length: number, message?: KCheckMessage): this {
		return this.link('max', numberBound(length), checkMessage(message, 'max'))
	}

	length(length: number, message?: KCheckMessage): this {
		return this.link('length', numberBound(length), checkMessage(message, 'length'))
	}
}

/** Positional input and output types stay local to tuple schemas. */
export type KTupleInput<T extends readonly KType[], R extends KType = KNever> = R extends KNever
	? { -readonly [I in keyof T]: T[I]['_req']['type'] }
	: [...{ -readonly [I in keyof T]: T[I]['_req']['type'] }, ...R['_req']['type'][]]
export type KTupleOutput<T extends readonly KType[], R extends KType = KNever> = R extends KNever
	? { -readonly [I in keyof T]: T[I]['_output'] }
	: [...{ -readonly [I in keyof T]: T[I]['_output'] }, ...R['_output'][]]
type TupleValidators<T extends readonly KType[], R extends KType> = [
	...{ -readonly [I in keyof T]: T[I]['_req'] },
	...R['_req'][],
]
type TupleOutputValidators<T extends readonly KType[], R extends KType> = [
	...{ -readonly [I in keyof T]: KOutputRequired<T[I]> },
	...KOutputRequired<R>[],
]
type TupleNative<T extends readonly KType[], R extends KType> = VArray<
	KTupleInput<T, R>,
	VUnion<(T[number] | R)['_req']['type'], TupleValidators<T, R>>
>
type TupleOutputNative<T extends readonly KType[], R extends KType> = VArray<
	KTupleOutput<T, R>,
	VUnion<(T[number] | R)['_output'], TupleOutputValidators<T, R>>
>

export class KTuple<T extends readonly KType[], R extends KType = KNever> extends KSchema<
	KTupleOutput<T, R>,
	TupleNative<T, R>,
	true extends (T[number] | R)['_d'] ? true : false,
	TupleNative<T, R>,
	true extends (T[number] | R)['_t'] ? true : false
> {
	declare readonly _or: TupleOutputNative<T, R>
	declare readonly _oo: TupleOutputNative<T, R>

	rest<S extends KType>(schema: S): KTuple<T, S> {
		if (this.prev !== null) throw new TypeError('k.tuple().rest() must be called before checks')
		// SAFETY: a tuple root stores its items and optional rest schema.
		const arg = this.arg as KTupleArg
		// SAFETY: the new tuple preserves the same positional schemas T.
		return tuple(arg.items as T, schema)
	}
}

/** Key validators a Convex record accepts at push: a string, an id, or a union of those. */
type KNativeKeyValidator =
	| VString<any, 'required'>
	| VId<any, 'required'>
	| VUnion<any, (VString<any, 'required'> | VId<any, 'required'>)[], 'required', any>

/** Key validators that are a finite set of string literals: `k.record` builds an object for them. */
type KLiteralSetValidator =
	| VLiteral<string, 'required'>
	| VUnion<string, VLiteral<string, 'required'>[], 'required', any>
export type KLiteralKeyValidator =
	| KLiteralSetValidator
	| VUnion<string, KLiteralSetValidator[], 'required', any>

/**
 * A record key: a string or id kind (a native record), or an enum, string literal or union of string
 * literals (an object with one field per value, since Convex refuses literal record keys at push).
 */
export type KRecordKey = KType & { readonly _req: KNativeKeyValidator | KLiteralKeyValidator }

export class KRecord<K extends KRecordKey, V extends KType> extends KSchema<
	Record<K['_output'], V['_output']>,
	VRecord<Record<K['_req']['type'], V['_req']['type']>, K['_req'], V['_req']>,
	V['_d'],
	VRecord<Record<K['_req']['type'], V['_req']['type']>, K['_req'], V['_req']>,
	V['_t']
> {
	declare readonly _or: VRecord<Record<K['_output'], V['_output']>, K['_req'], KOutputRequired<V>>
	declare readonly _oo: VRecord<Record<K['_output'], V['_output']>, K['_req'], KOutputRequired<V>>
}

export class KUnion<M extends readonly KType[]> extends KSchema<
	M[number]['_output'],
	VUnion<M[number]['_req']['type'], { -readonly [I in keyof M]: M[I]['_req'] }>,
	M[number]['_d'],
	VUnion<M[number]['_req']['type'], { -readonly [I in keyof M]: M[I]['_req'] }>,
	M[number]['_t']
> {
	declare readonly _or: VUnion<
		M[number]['_output'],
		{ -readonly [I in keyof M]: KOutputRequired<M[I]> }
	>
	declare readonly _oo: VUnion<
		M[number]['_output'],
		{ -readonly [I in keyof M]: KOutputRequired<M[I]> }
	>
}

/** A union of objects dispatched on one literal or enum field when parsed; natively a plain union. */
/** An object option of a discriminated union: its output carries the key with a literal value. */
export type KDiscriminatedOption<Key extends string> = KType & {
	readonly _output: { readonly [P in Key]: KLiteralValue }
}

export class KDiscriminatedUnion<Key extends string, M extends readonly KType[]> extends KUnion<M> {
	get discriminator(): Key {
		// SAFETY: k.discriminatedUnion stores its key with the options as the root argument.
		return (rootOf(this).arg as { readonly key: Key }).key
	}

	get options(): M {
		// SAFETY: k.discriminatedUnion stores its key and options as the root argument.
		const arg = rootOf(this).arg as KDiscriminated
		// SAFETY: the stored options are the tuple this class was created with.
		return arg.options as M
	}
}

const stringRoot = new KString(null, 'string', undefined, undefined)
const numberRoot = new KNumber(null, 'number', undefined, undefined)
const intRoot = new KNumber(null, 'int', undefined, undefined)
const int64Root = new KInt64(null, 'int64', undefined, undefined)
const booleanRoot = new KBoolean(null, 'boolean', undefined, undefined)
const nullRoot = new KNull(null, 'null', undefined, undefined)
const voidRoot = new KVoid(null, 'void', undefined, undefined)
const bytesRoot = new KBytes(null, 'bytes', undefined, undefined)
const anyRoot = new KAny(null, 'any', undefined, undefined)
const neverRoot = new KNever(null, 'never', undefined, undefined)
const jsonRoot = new KJson(null, 'json', undefined, undefined)

// Scalar roots wrap one native value. Containers and parameterised leaves stay lazy.
stringRoot.native = v.string()
numberRoot.native = v.number()
intRoot.native = numberRoot.native
int64Root.native = v.int64()
booleanRoot.native = v.boolean()
nullRoot.native = v.null()
voidRoot.native = nullRoot.native
bytesRoot.native = v.bytes()
anyRoot.native = v.any()

const ipv4Format: KFormat = Object.freeze({ kind: 'ipv4' })
const ipv6Format: KFormat = Object.freeze({ kind: 'ipv6' })
const uuidFormat: KFormat = Object.freeze({ kind: 'uuid' })
const emailFormat: KFormat = Object.freeze({ kind: 'email' })

/**
 * Argument-less factories return one shared root: records are immutable, so sharing is safe. Factories
 * that take an array or map freeze it in place, so what a schema holds cannot change after declaration.
 */
export function string(): KString {
	return stringRoot
}

/** `k.string().email()`. */
export function email(message?: KCheckMessage): KString {
	return stringRoot.email(message)
}

/** `k.string().url(options)`. */
export function url(options?: string | KUrlOptions): KString {
	return stringRoot.url(options)
}

/**
 * Zod's `z.custom<T>()`: any value, typed `T`, optionally checked by `guard` (issue `custom`).
 * Natively `v.any()`, so nothing but the guard validates it: use it for values a schema cannot
 * describe (branded strings, SDK payloads), not in place of a real shape.
 */
export function custom<T = unknown>(
	// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- a custom guard receives the undecoded value and, as in Zod, passes on any truthy result.
	guard?: (value: unknown) => unknown,
	message?: string | KRefineOptions,
): KCustom<T> {
	// Zod accepts any truthy result from a custom guard. A promise-like result goes to the parser
	// as it is: the parser fails it and contains its rejection.
	const schema: KSchema<any, VAny> =
		guard === undefined
			? anyRoot
			: anyRoot.refine((value) => {
					const result = guard(value)
					if (!result) return false
					// SAFETY: any truthy value can be asked for a `then` member.
					const then = (result as { then?: unknown }).then
					// oxlint-disable-next-line anti-slop/no-runtime-typeof -- an untyped caller's async guard returns a thenable, native or not.
					if (typeof then !== 'function') return true
					// SAFETY: the parser's refine check accepts only `true`, so a thenable is a failure there.
					return result as boolean
				}, message)
	// SAFETY: KCustom declares the caller's type over the same v.any() records.
	return schema as KCustom<T>
}

/** The schema of `k.custom<T>()`: a `v.any()` whose value is typed `T`. */
export type KCustom<T> = KSchema<T, VAny<T>>

export function ipv4(message?: KCheckMessage): KString {
	return stringRoot.ipv4(message)
}

export function ipv6(message?: KCheckMessage): KString {
	return stringRoot.ipv6(message)
}

export function uuid(message?: KCheckMessage): KString {
	return stringRoot.uuid(message)
}

export function never(): KNever {
	return neverRoot
}

export function number(): KNumber {
	return numberRoot
}

/** A number that must be an integer; one root record whose op carries the integer check. */
export function int(): KNumber {
	return intRoot
}

export function int64(): KInt64 {
	return int64Root
}

export function boolean(): KBoolean {
	return booleanRoot
}

export function nullValue(): KNull {
	return nullRoot
}

/** For `returns` or contract results; clients receive null when the handler returns nothing. */
export function voidValue(): KVoid {
	return voidRoot
}

export function bytes(): KBytes {
	return bytesRoot
}

export function any(): KAny {
	return anyRoot
}

export function json(): KJson {
	return jsonRoot
}

export function literal<const V extends KLiteralValue>(value: V): KLiteral<V> {
	return new KLiteral<V>(null, 'literal', value, undefined)
}

// Two overloads, not one conditional return type: a conditional stays deferred when the values
// are a type parameter of the caller, and the enum then infers nothing.
// The list form is declared last, so `ReturnType` and `k.enum<[...]>` keep meaning the list form.
// Its object form refuses a list in the parameter, not in the constraint, so `k.enum<[...]>` still
// instantiates.
export function enumOf<const V extends Readonly<Record<string, string>> | readonly unknown[]>(
	values: V & (V extends readonly unknown[] ? never : unknown),
): KEnum<KEnumValues<Extract<V[keyof V], string>>>
export function enumOf<const V extends readonly string[]>(values: V): KEnum<V>
export function enumOf(
	values: readonly string[] | Readonly<Record<string, string>>,
): KEnum<KEnumValues<string>> {
	if (Array.isArray(values)) return enumValues<KEnumValues<string>>(values)
	if (
		values === null ||
		(Object.getPrototypeOf(values) !== Object.prototype && Object.getPrototypeOf(values) !== null)
	)
		throw new TypeError('k.enum() expects a string array or an object of string values')
	for (const [key, value] of Object.entries(values)) {
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Untyped callers can supply non-string enum values.
		if (typeof value !== 'string')
			throw new TypeError(`k.enum() value at key "${key}" must be a string`)
	}
	return enumValues<KEnumValues<string>>(Object.values(values))
}

export function id<T extends string>(table: T): KId<T> {
	return new KId<T>(null, 'id', table, undefined)
}

export function array<E extends KType>(element: E): KArray<E> {
	assertSchema(element, 'array element')
	return new KArray<E>(null, 'array', element, undefined)
}

export function tuple<const T extends readonly KType[], R extends KType = KNever>(
	items: T,
	rest?: R,
): KTuple<T, R> {
	for (const [index, item] of items.entries()) assertSchema(item, `tuple item ${index}`)
	if (rest !== undefined) assertSchema(rest, 'tuple rest')
	return new KTuple<T, R>(
		null,
		'tuple',
		Object.freeze({ items: Object.freeze([...items]), rest }),
		undefined,
	)
}

/** The native record root; `k.record` (in object.ts) decides between this and an object. */
export function nativeRecord<K extends KRecordKey, V extends KType>(
	key: K,
	value: V,
): KRecord<K, V> {
	return new KRecord<K, V>(null, 'record', Object.freeze([key, value]), undefined)
}

export function union<const M extends readonly [KType, KType, ...KType[]]>(members: M): KUnion<M> {
	for (const [index, member] of members.entries()) assertSchema(member, `union member ${index}`)
	return new KUnion<M>(null, 'union', Object.freeze(members), undefined)
}

export function discriminatedUnion<
	Key extends string,
	const M extends readonly [KDiscriminatedOption<Key>, ...KDiscriminatedOption<Key>[]],
>(key: Key, options: M): KDiscriminatedUnion<Key, M> {
	for (const [index, option] of options.entries())
		assertSchema(option, `discriminatedUnion option ${index}`)
	return new KDiscriminatedUnion<Key, M>(
		null,
		'discriminatedUnion',
		Object.freeze({
			key,
			options: Object.freeze(options),
			dispatch: discriminatorDispatch(key, options),
		}),
		undefined,
	)
}

function rootOf(node: KNode): KNode {
	let root = node
	while (root.prev !== null) root = root.prev
	return root
}

function enumValues<T extends readonly [string, ...string[]]>(values: readonly string[]): KEnum<T> {
	if (values.length === 0) throw new TypeError('k.enum() needs at least one value')
	for (const [index, value] of values.entries()) {
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Enum definitions can come from untyped callers.
		if (typeof value !== 'string')
			throw new TypeError(`k.enum() value at index ${index} must be a string`)
	}
	Object.freeze(values)
	return new KEnum<T>(null, 'enum', Object.freeze([...new Set(values)]), undefined)
}

function int64Bound(value: bigint): bigint {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- normalize safe numeric bounds from JavaScript callers at definition time.
	if (typeof value === 'bigint') return value
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- BigInt must only receive a safe integer number here.
	if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
	throw new TypeError('k.int64() bounds must be bigints or safe integer numbers')
}

function numberBound(value: number): number {
	if (Number.isNaN(value)) throw new TypeError('k: a bound cannot be NaN')
	return value
}
