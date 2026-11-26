import type { ObjectType, VObject } from 'convex/values'
import {
	enumOf,
	nativeRecord,
	type KEnum,
	type KEnumValues,
	type KLiteralKeyValidator,
	type KRecord,
	type KRecordKey,
} from './kinds'
import { isFieldName } from './names'
import { KOptional, KSchema } from './schema'
import type {
	Flat,
	KAnyDiffers,
	KAnyTransform,
	KFields,
	KNativeFields,
	KObjectOutput,
	KOutputFields,
	KNode,
	KType,
} from './types'

/**
 * A strict object. `pick`, `omit`, `extend` and `partial` build a new object root over the same field
 * schema instances, so retained fields keep their checks, defaults and normalisers; refinements declared
 * on the object itself are not carried over, because they may read fields the new object lacks.
 */
export class KObject<F extends KFields> extends KSchema<
	KAnyDiffers<F> extends true ? KObjectOutput<F> : ObjectType<KNativeFields<F>>,
	VObject<KObjectInput<F>, KNativeFields<F>>,
	KAnyDiffers<F>,
	VObject<KObjectInput<F>, KNativeFields<F>>,
	KAnyTransform<F>
> {
	declare readonly _or: VObject<this['_output'], KOutputFields<F>>
	declare readonly _oo: VObject<this['_output'], KOutputFields<F>>

	/**
	 * The field map, frozen when first read: it is the only handle through which code other than the
	 * declaring caller can reach it. Reusing a field keeps every behaviour declared on it.
	 */
	// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- `.shape` is the field-map name apps already use (R6).
	get shape(): F {
		return Object.freeze(fieldsOf(this))
	}

	pick<K extends keyof F & string>(...keys: K[]): KObject<Pick<F, K>> {
		const fields = fieldsOf(this)
		const out: Record<string, KType> = {}
		for (const key of keys) out[key] = fields[key]
		return object(retyped<Pick<F, K>>(out))
	}

	omit<K extends keyof F & string>(...keys: K[]): KObject<Omit<F, K>> {
		const fields = fieldsOf(this)
		const out: Record<string, KType> = {}
		const dropped = new Set<string>(keys)
		for (const key in fields) if (!dropped.has(key)) out[key] = fields[key]
		return object(retyped<Omit<F, K>>(out))
	}

	/** Add or replace fields; a key present in both takes the new schema. */
	extend<E extends KFields>(fields: E): KObject<Flat<Omit<F, keyof E> & E>> {
		return object(retyped<Flat<Omit<F, keyof E> & E>>({ ...fieldsOf(this), ...fields }))
	}

	/**
	 * Every field optional, for patches: a field that had a default becomes plain optional, so an omitted
	 * field stays omitted instead of overwriting a stored value. Other field behaviour is kept.
	 */
	partial(): KObject<{ [K in keyof F]: KOptional<F[K]> }> {
		const fields = fieldsOf(this)
		const out: Record<string, KType> = {}
		for (const key in fields) out[key] = optionalOf(fields[key])
		return object(retyped<{ [K in keyof F]: KOptional<F[K]> }>(out))
	}

	/**
	 * Fields made required again, the inverse of `partial()`: an optional field loses its top
	 * `optional()` wrappers. With no keys every field is affected. Other field behaviour, defaults included, is kept.
	 */
	required<K extends keyof F & string = keyof F & string>(
		...keys: K[]
	): KObject<{ [P in keyof F]: P extends K ? KRequiredField<F[P]> : F[P] }> {
		const fields = fieldsOf(this)
		const chosen = keys.length === 0 ? null : new Set<string>(keys)
		const out: Record<string, KType> = {}
		for (const key in fields)
			out[key] = chosen === null || chosen.has(key) ? requiredOf(fields[key]) : fields[key]
		return object(retyped<{ [P in keyof F]: P extends K ? KRequiredField<F[P]> : F[P] }>(out))
	}

	/** A `k.enum` of the field names, in declaration order. */
	keyof(): KEnum<KEnumValues<keyof F & string>> {
		// SAFETY: the keys of the field map are the string keys of F.
		return enumOf(Object.keys(fieldsOf(this)) as KEnumValues<keyof F & string>)
	}

	/** Parse removes unknown keys instead of reporting them. The native validator stays strict. */
	strip(): this {
		return this.link('strip', undefined, undefined)
	}
}

/**
 * The input type of a strict object. With no fields, `{}` would admit any object literal, so it is a
 * record of `never` instead: an object with no fields accepts no keys, as v1's strict Zod object did.
 */
export type KObjectInput<F extends KFields> = keyof F extends never
	? { readonly [key: string]: never }
	: ObjectType<KNativeFields<F>>

/**
 * The field map is kept by reference, not copied, and frozen in place when `.shape` is first read.
 * Freezing every map at declaration costs a hidden-class transition per object shape (measured
 * +0.28 MB on the 400-schema bench), so the caller's literal stays writable until then; do not mutate
 * it after declaring.
 */
/** A field with its top `optional()` (and `partial()`) wrappers removed; any other field as it is. */
export type KRequiredField<S extends KType> = S extends KOptional<infer I> ? KRequiredField<I> : S

export function object<F extends KFields>(fields: F): KObject<F> {
	return new KObject<F>(null, 'object', fields, undefined)
}

/** A record whose key is a finite set of string literals: one field per value. */
export type KLiteralRecord<K extends KType, V extends KType> = KObject<{ [P in K['_output']]: V }>

/** The optional-keys form: one optional field per value. */
export type KPartialRecord<K extends KType, V extends KType> = KObject<{
	[P in K['_output']]: KOptional<V>
}>

/**
 * A record. A string or id key builds a native record. A key that is a finite set of string literals
 * (`k.enum`, `k.literal`, a union of literals) builds a strict object with one required field per
 * value, as v1's `z.record(z.enum(…), v)` did: Convex refuses literal record keys at push.
 */
export function record<K extends KRecordKey, V extends KType>(
	key: K,
	value: V,
): K['_req'] extends KLiteralKeyValidator ? KLiteralRecord<K, V> : KRecord<K, V>
export function record(key: KRecordKey, value: KType): KType {
	const literals = recordKeyLiterals(key, 'k.record')
	if (literals === null) return nativeRecord(key, value)
	const fields: Record<string, KType> = {}
	for (const literal of literals) fields[literal] = value
	return object(fields)
}

/** `z.partialRecord`: an object with one optional field per value of a finite literal key set. */
export function partialRecord<
	K extends KType & { readonly _req: KLiteralKeyValidator },
	V extends KType,
>(key: K, value: V): KPartialRecord<K, V>
export function partialRecord(key: KType, value: KType): KType {
	const literals = recordKeyLiterals(key, 'k.partialRecord')
	if (literals === null)
		throw new Error('k.partialRecord() needs a finite set of string literal keys')
	const optional = optionalOf(value)
	const fields: Record<string, KType> = {}
	for (const literal of literals) fields[literal] = optional
	return object(fields)
}

/**
 * The literal values of a record key, or null for a string or id key (a native record). Any other key
 * kind, or a union mixing literals with strings, throws at declaration naming what was found.
 */
function recordKeyLiterals(key: KNode, factory: string): readonly string[] | null {
	let root = key
	let chained: KNode | null = null
	while (root.prev !== null) {
		if (root.op !== 'describe') chained ??= root
		root = root.prev
	}
	const literals = rootKeyLiterals(root, factory)
	if (literals !== null && chained !== null)
		throw new Error(`${factory}() key: a literal key set cannot carry '${chained.op}'`)
	return literals
}

function rootKeyLiterals(root: KNode, factory: string): readonly string[] | null {
	switch (root.op) {
		case 'string':
		case 'id':
		case 'isoDate':
		case 'isoDateTime':
			return null
		case 'literal':
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- k.literal also accepts numbers, bigints and booleans.
			if (typeof root.arg !== 'string')
				throw new Error(`${factory}() key must be a string literal, got ${String(root.arg)}`)
			return checkedKeys([root.arg], factory)
		case 'enum':
			// SAFETY: k.enum stores its non-empty value list as the root argument.
			return checkedKeys(root.arg as readonly string[], factory)
		case 'union': {
			// SAFETY: k.union stores its member schemas as the root argument.
			const members = root.arg as readonly KNode[]
			const literals: string[] = []
			let native = 0
			for (const member of members) {
				const set = recordKeyLiterals(member, factory)
				if (set === null) native++
				else literals.push(...set)
			}
			if (native === members.length) return null
			if (native > 0)
				throw new Error(`${factory}() key: a union cannot mix literals with strings or ids`)
			return [...new Set(literals)]
		}
		default:
			throw new Error(`${factory}() key must be a string, id or string literals; got '${root.op}'`)
	}
}

/**
 * Literal keys become object field names. Convex refuses a field name that is empty, longer than 1024
 * characters, starts with '$' or holds a non-printable or non-ASCII character
 * (`validateObjectField` in convex/src/values/value.ts). A leading '_' is allowed, as for `_id`.
 */
function checkedKeys(keys: readonly string[], factory: string): readonly string[] {
	for (const key of keys)
		if (!isFieldName(key))
			throw new Error(`${factory}() key '${key}' is not a valid Convex field name`)
	return keys
}

/** The field map built by pick, omit, extend or partial, under the type its method states. */
function retyped<T extends KFields>(fields: KFields): T {
	// SAFETY: each caller builds exactly the keys and field schemas its declared result type names.
	return fields as T
}

function optionalOf(field: KType): KType {
	// SAFETY: every field value at runtime is a KSchema record created by a k factory.
	return new KOptional(field as KSchema, 'partial', undefined, undefined)
}

function requiredOf(field: KType): KType {
	let current = field
	while (current.op === 'optional' || current.op === 'partial')
		// SAFETY: an optional record's predecessor is the schema it wraps.
		current = current.prev as KType
	return current
}

function fieldsOf<F extends KFields>(node: KObject<F>): F {
	let root: KNode = node
	while (root.prev !== null) root = root.prev
	// SAFETY: k.object stores its field map as the root argument.
	return root.arg as F
}
