import type { GenericId } from 'convex/values'
import { KSchema } from './schema'
import type { KFields, KLiteralValue, KObjectInput, KObjectOutput, KType } from './types'

export class KString extends KSchema<string> {
	declare readonly _kind: 'string'

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

export class KNumber extends KSchema<number> {
	declare readonly _kind: 'number'

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

export class KBoolean extends KSchema<boolean> {
	declare readonly _kind: 'boolean'
}

export class KNull extends KSchema<null> {
	declare readonly _kind: 'null'
}

export class KLiteral<V extends KLiteralValue> extends KSchema<V> {
	declare readonly _kind: 'literal'
}

export class KEnum<V extends readonly string[]> extends KSchema<V[number]> {
	declare readonly _kind: 'enum'
	declare readonly _def: V
}

export class KId<T extends string> extends KSchema<GenericId<T>> {
	declare readonly _kind: 'id'
}

export class KArray<E extends KType> extends KSchema<E['_output'][], E['_input'][]> {
	declare readonly _kind: 'array'
	declare readonly _def: E

	min(length: number, message?: string): this {
		return this.link('min', length, message)
	}

	max(length: number, message?: string): this {
		return this.link('max', length, message)
	}
}

export class KObject<F extends KFields> extends KSchema<KObjectOutput<F>, KObjectInput<F>> {
	declare readonly _kind: 'object'
	declare readonly _def: F
}

export class KUnion<M extends readonly KType[]> extends KSchema<
	M[number]['_output'],
	M[number]['_input']
> {
	declare readonly _kind: 'union'
	declare readonly _def: M
}

export function string(): KString {
	return new KString(null, 'string', undefined, undefined)
}

export function number(): KNumber {
	return new KNumber(null, 'number', undefined, undefined)
}

/** A number that must be an integer; one root record whose op carries the integer check. */
export function int(): KNumber {
	return new KNumber(null, 'int', undefined, undefined)
}

export function boolean(): KBoolean {
	return new KBoolean(null, 'boolean', undefined, undefined)
}

export function nullValue(): KNull {
	return new KNull(null, 'null', undefined, undefined)
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
