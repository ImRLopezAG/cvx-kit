import type {
	GenericId,
	ObjectType,
	VArray,
	VBoolean,
	VFloat64,
	VId,
	VLiteral,
	VNull,
	VObject,
	VString,
	VUnion,
} from 'convex/values'
import { KSchema } from './schema'
import type {
	KFields,
	KHasDefault,
	KLiteralValue,
	KNativeFields,
	KObjectOutput,
	KType,
} from './types'

export class KString extends KSchema<string, VString<string>> {
	min(length: number, message?: string): this {
		return this.link('min', length, message)
	}

	max(length: number, message?: string): this {
		return this.link('max', length, message)
	}

	regex(pattern: RegExp, message?: string): this {
		return this.link('regex', pattern, message)
	}

	trim(): this {
		return this.link('trim', undefined, undefined)
	}
}

export class KNumber extends KSchema<number, VFloat64<number>> {
	min(value: number, message?: string): this {
		return this.link('min', value, message)
	}

	max(value: number, message?: string): this {
		return this.link('max', value, message)
	}

	int(message?: string): this {
		return this.link('int', undefined, message)
	}
}

export class KBoolean extends KSchema<boolean, VBoolean<boolean>> {}

export class KNull extends KSchema<null, VNull<null>> {}

export class KLiteral<V extends KLiteralValue> extends KSchema<V, VLiteral<V>> {}

export class KEnum<V extends readonly [string, ...string[]]> extends KSchema<
	V[number],
	V extends readonly [infer Only extends string]
		? VLiteral<Only>
		: VUnion<V[number], { -readonly [I in keyof V]: VLiteral<V[I]> }>
> {}

export class KId<T extends string> extends KSchema<GenericId<T>, VId<GenericId<T>>> {}

export class KArray<E extends KType> extends KSchema<
	E['_output'][],
	VArray<E['_req']['type'][], E['_req']>,
	E['_d']
> {
	min(length: number, message?: string): this {
		return this.link('min', length, message)
	}

	max(length: number, message?: string): this {
		return this.link('max', length, message)
	}
}

export class KObject<F extends KFields> extends KSchema<
	KHasDefault<F> extends true ? KObjectOutput<F> : ObjectType<KNativeFields<F>>,
	VObject<ObjectType<KNativeFields<F>>, KNativeFields<F>>,
	KHasDefault<F>
> {}

export class KUnion<M extends readonly KType[]> extends KSchema<
	M[number]['_output'],
	VUnion<M[number]['_req']['type'], { -readonly [I in keyof M]: M[I]['_req'] }>,
	M[number]['_d']
> {}

const stringRoot = new KString(null, 'string', undefined, undefined)
const numberRoot = new KNumber(null, 'number', undefined, undefined)
const intRoot = new KNumber(null, 'int', undefined, undefined)
const booleanRoot = new KBoolean(null, 'boolean', undefined, undefined)
const nullRoot = new KNull(null, 'null', undefined, undefined)

/** Argument-less factories return one shared root: records are immutable, so sharing is safe. */
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

export function boolean(): KBoolean {
	return booleanRoot
}

export function nullValue(): KNull {
	return nullRoot
}

export function literal<const V extends KLiteralValue>(value: V): KLiteral<V> {
	return new KLiteral<V>(null, 'literal', value, undefined)
}

export function enumOf<const V extends readonly [string, ...string[]]>(values: V): KEnum<V> {
	if (values.length === 0) throw new Error('k.enum() needs at least one value')
	return new KEnum<V>(null, 'enum', values, undefined)
}

export function id<T extends string>(table: T): KId<T> {
	return new KId<T>(null, 'id', table, undefined)
}

export function array<E extends KType>(element: E): KArray<E> {
	return new KArray<E>(null, 'array', element, undefined)
}

export function object<F extends KFields>(fields: F): KObject<F> {
	return new KObject<F>(null, 'object', fields, undefined)
}

export function union<const M extends readonly [KType, KType, ...KType[]]>(members: M): KUnion<M> {
	return new KUnion<M>(null, 'union', members, undefined)
}
