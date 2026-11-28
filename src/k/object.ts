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
import { isFieldName, setOwn } from './names'
import { assertSchema, KOptional, KSchema } from './schema'
import type {
	KExtendedFields,
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
 * An object. The native validator is closed and the kit's boundaries reject unknown keys; `parse` in
 * application code strips them unless the object is `.strict()` (or keeps them with `.loose()`). `pick`, `omit`, `extend`, `partial` and `required` build a new object root over the
 * same field schema instances, keeping the receiver's unknown-key policy (`strict()`, `strip()`, `loose()`) as
 * Zod 4 does; with object-level checks they throw unless told to drop or keep them.
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

	pick<K extends keyof F & string>(...keys: K[]): KObject<Pick<F, K>>
	pick<K extends keyof F & string>(...keys: KMaskArgs<K>): KObject<Pick<F, K>>
	pick<K extends keyof F & string>(...keys: KMaskArgs<K>): KObject<Pick<F, K>> {
		const names = maskKeys(this, 'pick', keys)
		const fields = fieldsOf(this)
		const out: Record<string, KType> = {}
		for (const key of names) setOwn(out, key, fields[key])
		return withPolicy(this, object(retyped<Pick<F, K>>(out)))
	}

	omit<K extends keyof F & string>(...keys: K[]): KObject<Omit<F, K>>
	omit<K extends keyof F & string>(...keys: KMaskArgs<K>): KObject<Omit<F, K>>
	omit<K extends keyof F & string>(...keys: KMaskArgs<K>): KObject<Omit<F, K>> {
		const dropped = new Set<string>(maskKeys(this, 'omit', keys))
		const fields = fieldsOf(this)
		const out: Record<string, KType> = {}
		for (const key in fields) if (!dropped.has(key)) setOwn(out, key, fields[key])
		return withPolicy(this, object(retyped<Omit<F, K>>(out)))
	}

	/** Add or replace fields; a key present in both takes the new schema. */
	extend<E extends KFields>(fields: E, options?: KExtendOptions): KObject<KExtendedFields<F, E>> {
		const kept = derivedChecks(this, 'extend', options)
		let out: KObject<KExtendedFields<F, E>> = withPolicy(
			this,
			object(retyped<KExtendedFields<F, E>>({ ...fieldsOf(this), ...fields })),
		)
		if (options !== undefined && 'keepChecks' in options)
			for (const record of kept) out = out.link(record.op, record.arg, record.message)
		return out
	}

	/**
	 * Every field optional, for patches: a field that had a default becomes plain optional, so an omitted
	 * field stays omitted instead of overwriting a stored value. Other field behaviour is kept.
	 */
	partial<K extends keyof F & string = keyof F & string>(...keys: K[]): KPartialObject<F, K>
	partial(options?: KDeriveOptions): KPartialObject<F, keyof F & string>
	partial<K extends keyof F & string>(...keys: KMaskArgs<K>): KPartialObject<F, K>
	partial(...keys: (string | KDeriveOptions | undefined)[]): KType {
		const names = maskKeys(
			this,
			'partial',
			keys.filter((key) => key !== undefined),
		)
		const fields = fieldsOf(this)
		const chosen = names.length === 0 ? null : new Set<string>(names)
		const out: Record<string, KType> = {}
		for (const key in fields)
			setOwn(out, key, chosen === null || chosen.has(key) ? optionalOf(fields[key]) : fields[key])
		return withPolicy(this, object(out))
	}

	/**
	 * Fields made required again, the inverse of `partial()`: an optional field loses its top
	 * `optional()` wrappers. With no keys every field is affected. Other field behaviour, defaults included, is kept.
	 */
	required<K extends keyof F & string = keyof F & string>(...keys: K[]): KRequiredObject<F, K>
	required(options: KDeriveOptions): KRequiredObject<F, keyof F & string>
	required<K extends keyof F & string>(
		...keys: [...keys: K[], options: KDeriveOptions]
	): KRequiredObject<F, K>
	required(...keys: (string | KDeriveOptions)[]): KType {
		const names = maskKeys(this, 'required', keys)
		const fields = fieldsOf(this)
		const chosen = names.length === 0 ? null : new Set<string>(names)
		const out: Record<string, KType> = {}
		for (const key in fields)
			setOwn(out, key, chosen === null || chosen.has(key) ? requiredOf(fields[key]) : fields[key])
		return withPolicy(this, object(out))
	}

	/** A `k.enum` of the field names, in declaration order. */
	keyof(): KEnum<KEnumValues<keyof F & string>> {
		// SAFETY: the keys of the field map are the string keys of F.
		return enumOf(Object.keys(fieldsOf(this)) as KEnumValues<keyof F & string>)
	}

	/**
	 * Unknown keys are removed everywhere this object is parsed, including where the kit parses it in
	 * full at a boundary (inside `.catch`, under `skipConvexValidation`). `parse` in application code
	 * already strips; the native validator stays closed.
	 */
	strip(): this {
		return this.link('strip', undefined, undefined)
	}

	/** `parse` reports unknown keys (`unrecognized_key`) instead of removing them. */
	strict(): this {
		return this.link('strict', undefined, undefined)
	}

	/** Keep unknown keys on parse. */
	loose(): this {
		return this.link('loose', undefined, undefined)
	}
}

/** The result of `partial(...keys)`. */
export type KPartialObject<F extends KFields, K extends string> = KObject<{
	[P in keyof F]: P extends K ? KOptional<F[P]> : F[P]
}>

/** The result of `required(...keys)`. */
export type KRequiredObject<F extends KFields, K extends string> = KObject<{
	[P in keyof F]: P extends K ? KRequiredField<F[P]> : F[P]
}>

/** The opt-in that lets a derived object drop the receiver's object-level checks. */
export type KDeriveOptions = { readonly dropChecks: true }

/** `extend` may also keep them: `{ keepChecks: true }`. */
export type KExtendOptions = KDeriveOptions | { readonly keepChecks: true }

/** The keys of `pick`, `omit` and `required`, optionally followed by `{ dropChecks: true }`. */
export type KMaskArgs<K extends string> = [...keys: K[], options: KDeriveOptions]

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
	for (const key of Object.keys(fields)) assertSchema(fields[key], `field '${key}'`)
	return new KObject<F>(null, 'object', fields, undefined)
}

/** An object whose `parse` reports unknown keys; `k.object(fields).strict()`. */
export function strictObject<F extends KFields>(fields: F): KObject<F> {
	return object(fields).strict()
}

export function looseObject<F extends KFields>(fields: F): KObject<F> {
	return object(fields).loose()
}

/** A record whose key is a finite set of string literals: one field per value. */
export type KLiteralRecord<K extends KType, V extends KType> = KObject<{ [P in K['_output']]: V }>

/** The optional-keys form: one optional field per value. */
export type KPartialRecord<K extends KType, V extends KType> = KObject<{
	[P in K['_output']]: KOptional<V>
}>

/**
 * A record. A string or id key builds a native record. A key that is a finite set of string literals
 * (`k.enum`, `k.literal`, a union of literals) builds a `strict()` object with one required field per
 * value, as v1's `z.record(z.enum(…), v)` did: Convex refuses literal record keys at push.
 */
export function record<K extends KRecordKey, V extends KType>(
	key: K,
	value: V,
): K['_req'] extends KLiteralKeyValidator ? KLiteralRecord<K, V> : KRecord<K, V>
export function record(key: KRecordKey, value: KType): KType {
	assertSchema(key, 'record key')
	assertSchema(value, 'record value')
	const literals = recordKeyLiterals(key, 'k.record')
	if (literals === null) return nativeRecord(key, value)
	const fields: Record<string, KType> = {}
	for (const literal of literals) setOwn(fields, literal, value)
	return object(fields).strict()
}

/** `z.partialRecord`: an object with one optional field per value of a finite literal key set. */
export function partialRecord<
	K extends KType & { readonly _req: KLiteralKeyValidator },
	V extends KType,
>(key: K, value: V): KPartialRecord<K, V>
export function partialRecord(key: KType, value: KType): KType {
	assertSchema(key, 'record key')
	assertSchema(value, 'record value')
	const literals = recordKeyLiterals(key, 'k.partialRecord')
	if (literals === null)
		throw new Error('k.partialRecord() needs a finite set of string literal keys')
	const optional = optionalOf(value)
	const fields: Record<string, KType> = {}
	for (const literal of literals) setOwn(fields, literal, optional)
	return object(fields).strict()
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

function maskKeys<F extends KFields>(
	node: KObject<F>,
	method: string,
	args: readonly (string | KDeriveOptions)[],
): string[] {
	const last = args[args.length - 1]
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- a mask call's trailing argument may be its options object.
	const options = typeof last === 'object' ? last : undefined
	const keys = options === undefined ? args : args.slice(0, -1)
	if (
		(options !== undefined &&
			(options === null || Object.keys(options).length !== 1 || options.dropChecks !== true)) ||
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- an untyped caller can pass a mask before the options object.
		!keys.every((key) => typeof key === 'string')
	)
		throw new TypeError(
			`k: ${method}() expects the key-list form, e.g. ${method}('a', 'b'), optionally followed by { dropChecks: true }`,
		)
	for (const key of keys)
		if (!Object.hasOwn(fieldsOf(node), String(key)))
			throw new TypeError(`k: ${method}() has unrecognized key '${key}'`)
	derivedChecks(node, method, options)
	// SAFETY: every argument before the trailing options object was checked to be a key.
	return keys as string[]
}

// The receiver's object-level checks, oldest first; throws when they would be lost silently.
function derivedChecks(node: KNode, method: string, options: KExtendOptions | undefined): KNode[] {
	const checks: KNode[] = []
	for (let current = node; current.prev !== null; current = current.prev)
		if (current.op === 'refine' || current.op === 'check' || current.op === 'overwrite')
			checks.unshift(current)
	if (checks.length > 0 && options === undefined)
		throw new Error(
			`k: ${method}() would drop ${checks.length} object-level check(s); pass { dropChecks: true }${method === 'extend' ? ' or { keepChecks: true }' : ''}`,
		)
	return checks
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

/** The derived object with the receiver's unknown-key policy: the nearest `strip`, `strict` or `loose` record. */
function withPolicy<O extends KObject<any>>(receiver: KNode, derived: O): O {
	for (let current: KNode | null = receiver; current !== null; current = current.prev) {
		if (current.op === 'strip') return derived.strip()
		if (current.op === 'strict') return derived.strict()
		if (current.op === 'loose') return derived.loose()
	}
	return derived
}

function fieldsOf<F extends KFields>(node: KObject<F>): F {
	let root: KNode = node
	while (root.prev !== null) root = root.prev
	// SAFETY: k.object stores its field map as the root argument.
	return root.arg as F
}
