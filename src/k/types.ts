import type { GenericValidator, Validator, Value } from 'convex/values'

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

export type KRequiredValidator = Validator<any, 'required', any>

/**
 * Structural constraint for any `k` schema. Every member is a plain read of a class type argument:
 * `_req` is the required native validator, `validator` the input-side one (optional when the chain is
 * optional or defaulted) and `_d` whether a default sits anywhere inside, which is the only case where
 * the output type differs from the native validator's type.
 */
export interface KType {
	readonly _output: any
	readonly _req: KRequiredValidator
	readonly _d: boolean
	readonly validator: GenericValidator
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

/** Input-side native Convex validator type of a `k` schema: a defaulted field is optional. */
export type NativeOf<T extends KType> = T['validator']

export type KNativeFields<F extends KFields> = { [K in keyof F]: F[K]['validator'] }

export type KHasDefault<F extends KFields> = true extends F[keyof F]['_d'] ? true : false

/** Output of an object that holds a default somewhere: a defaulted field is required. */
export type KObjectOutput<F extends KFields> = Flat<
	{
		[K in keyof F as undefined extends F[K]['_output'] ? K : never]?: Exclude<
			F[K]['_output'],
			undefined
		>
	} & { [K in keyof F as undefined extends F[K]['_output'] ? never : K]: F[K]['_output'] }
>

type Flat<T> = { [K in keyof T]: T[K] }
