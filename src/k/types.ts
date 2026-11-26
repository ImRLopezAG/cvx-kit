import type {
	GenericValidator,
	OptionalProperty,
	VArray,
	VBoolean,
	VFloat64,
	VId,
	VLiteral,
	VNull,
	VObject,
	VString,
	VUnion,
	Value,
} from 'convex/values'

/** Type-level tag of a schema class; chained checks keep the tag of their predecessor. */
export type KKind =
	| 'string'
	| 'number'
	| 'boolean'
	| 'null'
	| 'literal'
	| 'enum'
	| 'id'
	| 'array'
	| 'object'
	| 'union'
	| 'optional'
	| 'nullable'
	| 'default'

/** Runtime record operation. Roots (`prev === null`) carry a kind op; every other record carries a chain op. */
export type KOp =
	| 'string'
	| 'number'
	| 'int'
	| 'boolean'
	| 'null'
	| 'literal'
	| 'enum'
	| 'id'
	| 'array'
	| 'object'
	| 'union'
	| 'min'
	| 'max'
	| 'regex'
	| 'trim'
	| 'refine'
	| 'optional'
	| 'nullable'
	| 'default'

/** Minimal structural constraint for any `k` schema. Kept free of `validator` so constraint checks never evaluate `NativeOf`. */
export interface KType {
	readonly _kind: KKind
	readonly _output: any
	readonly _input: any
}

export type KFields = Readonly<Record<string, KType>>

export type KLiteralValue = string | number | bigint | boolean

export type KRefinement = (value: never) => boolean

export type KArg =
	| Value
	| undefined
	| RegExp
	| KType
	| readonly KType[]
	| readonly string[]
	| KFields
	| KRefinement

export type KObjectOutput<F extends KFields> = Flat<
	{
		[K in keyof F as undefined extends F[K]['_output'] ? K : never]?: Exclude<
			F[K]['_output'],
			undefined
		>
	} & { [K in keyof F as undefined extends F[K]['_output'] ? never : K]: F[K]['_output'] }
>

export type KObjectInput<F extends KFields> = Flat<
	{
		[K in keyof F as undefined extends F[K]['_input'] ? K : never]?: Exclude<
			F[K]['_input'],
			undefined
		>
	} & { [K in keyof F as undefined extends F[K]['_input'] ? never : K]: F[K]['_input'] }
>

/** Input-side native Convex validator type of a `k` schema: a defaulted field is optional. */
export type NativeOf<T extends KType> = T extends {
	readonly _kind: 'optional' | 'default'
	readonly _def: infer I extends KType
}
	? Build<I, 'optional', T['_input']>
	: Build<T, 'required', T['_input']>

type Build<T extends KType, O extends OptionalProperty, Type> = T extends {
	readonly _kind: 'string'
}
	? VString<Type, O>
	: T extends { readonly _kind: 'number' }
		? VFloat64<Type, O>
		: T extends { readonly _kind: 'object'; readonly _def: infer F extends KFields }
			? VObject<Type, NativeFields<F>, O, FieldPathsOf<F>>
			: T extends { readonly _kind: 'id' }
				? VId<Type, O>
				: T extends { readonly _kind: 'boolean' }
					? VBoolean<Type, O>
					: T extends { readonly _kind: 'literal' }
						? VLiteral<Type, O>
						: T extends { readonly _kind: 'enum'; readonly _def: infer V extends readonly string[] }
							? V extends readonly [string]
								? VLiteral<Type, O>
								: VUnion<Type, { -readonly [I in keyof V]: VLiteral<V[I]> }, O>
							: T extends { readonly _kind: 'array'; readonly _def: infer E extends KType }
								? VArray<Type, Build<E, 'required', E['_input']>, O>
								: T extends { readonly _kind: 'nullable'; readonly _def: infer I extends KType }
									? VUnion<Type, [Build<I, 'required', I['_input']>, VNull<null>], O>
									: T extends {
												readonly _kind: 'union'
												readonly _def: infer M extends readonly KType[]
										  }
										? VUnion<
												Type,
												{ -readonly [I in keyof M]: Build<M[I], 'required', M[I]['_input']> },
												O
											>
										: T extends { readonly _kind: 'null' }
											? VNull<Type, O>
											: GenericValidator

type NativeFields<F extends KFields> = { [K in keyof F]: NativeOf<F[K]> }

type FieldPathsOf<F extends KFields> = {
	[K in keyof F & string]: K | `${K}.${NestedPaths<F[K]>}`
}[keyof F & string]

type NestedPaths<T extends KType> = T extends {
	readonly _kind: 'object'
	readonly _def: infer F extends KFields
}
	? FieldPathsOf<F>
	: T extends {
				readonly _kind: 'optional' | 'default' | 'nullable'
				readonly _def: infer I extends KType
		  }
		? NestedPaths<I>
		: T extends { readonly _kind: 'union'; readonly _def: infer M extends readonly KType[] }
			? NestedPaths<M[number]>
			: never

type Flat<T> = { [K in keyof T]: T[K] }
