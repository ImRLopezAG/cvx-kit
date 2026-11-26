import type { ObjectType, VObject } from 'convex/values'
import { KSchema, type KOptional } from './schema'
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
	VObject<ObjectType<KNativeFields<F>>, KNativeFields<F>>,
	KAnyDiffers<F>,
	VObject<ObjectType<KNativeFields<F>>, KNativeFields<F>>,
	KAnyTransform<F>
> {
	declare readonly _or: VObject<this['_output'], KOutputFields<F>>
	declare readonly _oo: VObject<this['_output'], KOutputFields<F>>

	/** The field map. Reusing a field keeps every behaviour declared on it. */
	// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- `.shape` is the field-map name apps already use (R6).
	get shape(): F {
		return fieldsOf(this)
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
	return (field as KSchema).optional()
}

function fieldsOf<F extends KFields>(node: KObject<F>): F {
	let root: KNode = node
	while (root.prev !== null) root = root.prev
	// SAFETY: k.object stores its field map as the root argument.
	return root.arg as F
}
