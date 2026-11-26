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
import { KSchema } from './schema'
import type {
	KCheckMessage,
	KDiscriminated,
	KLiteralValue,
	KNode,
	KOutputRequired,
	KType,
} from './types'

export class KString extends KSchema<string, VString<string>> {
	min(length: number, message?: KCheckMessage): this {
		return this.link('min', length, checkMessage(message, 'min'))
	}

	max(length: number, message?: KCheckMessage): this {
		return this.link('max', length, checkMessage(message, 'max'))
	}

	length(length: number, message?: KCheckMessage): this {
		return this.link('length', length, checkMessage(message, 'length'))
	}

	regex(pattern: RegExp, message?: KCheckMessage): this {
		return this.link('regex', pattern, checkMessage(message, 'regex'))
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
		return this.link('min', value, checkMessage(message, 'min'))
	}

	max(value: number, message?: KCheckMessage): this {
		return this.link('max', value, checkMessage(message, 'max'))
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

	/** A safe integer (`Number.isSafeInteger`): `not_integer`, or `too_small`/`too_big` outside the range. */
	safe(message?: KCheckMessage): this {
		return this.link('safe', undefined, checkMessage(message, 'safe'))
	}
}

export class KInt64 extends KSchema<bigint, VInt64<bigint>> {}

export class KBoolean extends KSchema<boolean, VBoolean<boolean>> {}

export class KNull extends KSchema<null, VNull<null>> {}

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

export class KEnum<V extends readonly [string, ...string[]]> extends KSchema<
	V[number],
	VUnion<V[number], { -readonly [I in keyof V]: VLiteral<V[I]> }>
> {
	get options(): V {
		// SAFETY: k.enum stores its value tuple as the root argument.
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
		return this.link('min', length, checkMessage(message, 'min'))
	}

	max(length: number, message?: KCheckMessage): this {
		return this.link('max', length, checkMessage(message, 'max'))
	}

	length(length: number, message?: KCheckMessage): this {
		return this.link('length', length, checkMessage(message, 'length'))
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
const bytesRoot = new KBytes(null, 'bytes', undefined, undefined)
const anyRoot = new KAny(null, 'any', undefined, undefined)
const jsonRoot = new KJson(null, 'json', undefined, undefined)

// Scalar roots wrap one native value. Containers and parameterised leaves stay lazy.
stringRoot.native = v.string()
numberRoot.native = v.number()
intRoot.native = numberRoot.native
int64Root.native = v.int64()
booleanRoot.native = v.boolean()
nullRoot.native = v.null()
bytesRoot.native = v.bytes()
anyRoot.native = v.any()

/**
 * Argument-less factories return one shared root: records are immutable, so sharing is safe. Factories
 * that take an array or map freeze it in place, so what a schema holds cannot change after declaration.
 */
export function string(): KString {
	return stringRoot
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

export function enumOf<const V extends readonly [string, ...string[]]>(values: V): KEnum<V> {
	if (values.length === 0) throw new Error('k.enum() needs at least one value')
	return new KEnum<V>(null, 'enum', Object.freeze(values), undefined)
}

export function id<T extends string>(table: T): KId<T> {
	return new KId<T>(null, 'id', table, undefined)
}

export function array<E extends KType>(element: E): KArray<E> {
	return new KArray<E>(null, 'array', element, undefined)
}

/** The native record root; `k.record` (in object.ts) decides between this and an object. */
export function nativeRecord<K extends KRecordKey, V extends KType>(
	key: K,
	value: V,
): KRecord<K, V> {
	return new KRecord<K, V>(null, 'record', Object.freeze([key, value]), undefined)
}

export function union<const M extends readonly [KType, KType, ...KType[]]>(members: M): KUnion<M> {
	return new KUnion<M>(null, 'union', Object.freeze(members), undefined)
}

export function discriminatedUnion<
	Key extends string,
	const M extends readonly [KDiscriminatedOption<Key>, ...KDiscriminatedOption<Key>[]],
>(key: Key, options: M): KDiscriminatedUnion<Key, M> {
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
	// SAFETY: callers pass a subset of an enum's values, which T names (for extract, in this enum's order).
	return enumOf(values as T)
}
