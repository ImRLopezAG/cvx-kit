import type { ObjectType, VObject } from 'convex/values'
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
export function object<F extends KFields>(fields: F): KObject<F> {
	return new KObject<F>(null, 'object', fields, undefined)
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

function fieldsOf<F extends KFields>(node: KObject<F>): F {
	let root: KNode = node
	while (root.prev !== null) root = root.prev
	// SAFETY: k.object stores its field map as the root argument.
	return root.arg as F
}
