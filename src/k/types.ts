import type { GenericValidator, Validator, Value } from 'convex/values'
import type { KPlan } from './parse'

/** Runtime record operation. Roots (`prev === null`) carry a kind op; every other record carries a chain op. */
export type KOp =
	| 'string'
	| 'number'
	| 'int'
	| 'int64'
	| 'boolean'
	| 'null'
	| 'bytes'
	| 'any'
	| 'json'
	| 'isoDate'
	| 'isoDateTime'
	| 'timestamp'
	| 'literal'
	| 'enum'
	| 'id'
	| 'array'
	| 'object'
	| 'record'
	| 'union'
	| 'discriminatedUnion'
	| 'min'
	| 'max'
	| 'gt'
	| 'lt'
	| 'finite'
	| 'safe'
	| 'length'
	| 'regex'
	| 'refine'
	| 'check'
	| 'trim'
	| 'lower'
	| 'upper'
	| 'overwrite'
	| 'optional'
	| 'partial'
	| 'describe'
	| 'nullable'
	| 'default'
	| 'strip'
	| 'transform'
	| 'pipe'

export type KRequiredValidator = Validator<any, 'required', any>

/**
 * Structural constraint for any `k` schema. Every member is a plain read of a class type argument:
 * `_req` is the required native validator, `validator` the input-side one (optional when the chain is
 * optional or defaulted), `_d` whether a default or transform sits anywhere inside (the only case where
 * the output side differs from the input side) and `_t` whether a transform or pipe does.
 */
export interface KType extends KNode {
	readonly _output: any
	readonly _req: KRequiredValidator
	readonly _d: boolean
	readonly _t: boolean
}

/**
 * The runtime view of any chain record, used by the compilers and the walker without the schema
 * generics. The memo slots are written once, on first use.
 */
export interface KNode {
	readonly prev: KNode | null
	readonly op: KOp
	readonly arg: KArg
	readonly message: KMessage
	native: GenericValidator | undefined
	outputNative: GenericValidator | undefined
	plan: KPlan | undefined
	readonly validator: GenericValidator
}

export type KFields = Readonly<Record<string, KType>>

export type KLiteralValue = string | number | bigint | boolean

export type KPath = (string | number)[]

/**
 * Options for a check: a replacement message. `error` is Zod 4's spelling of the same string; when both
 * are given `message` wins.
 */
export type KCheckOptions = { readonly message?: string; readonly error?: string }

/** A check's message argument: the message itself or its options object. */
export type KCheckMessage = string | KCheckOptions

/** Options for `refine`: a replacement message (or `error`) and a path, relative to the refined value, for the issue. */
export type KRefineOptions = KCheckOptions & { readonly path?: KPath }

export type KMessage = string | KRefineOptions | undefined

export type KCallback = (...args: never[]) => any

export type KDiscriminated = {
	readonly key: string
	readonly options: readonly KType[]
	/** Each discriminator value to its option, built at declaration. */
	readonly dispatch: ReadonlyMap<KLiteralValue, KNode>
}

export type KArg =
	| Value
	| undefined
	| RegExp
	| KType
	| readonly KType[]
	| readonly string[]
	| KFields
	| KCallback
	| KDiscriminated

/** Input-side native Convex validator type of a `k` schema: a defaulted field is optional. */
export type NativeOf<T extends KType> = T['validator']

/** Output-side native Convex validator type of a `k` schema: a defaulted field is required. */
export type OutputNativeOf<T extends KType> = T['_d'] extends true
	? T extends { readonly _oo: infer O extends GenericValidator }
		? O
		: never
	: T['validator']

/** Required output-side native validator, for array elements, union members and record values. */
export type KOutputRequired<T extends KType> = T['_d'] extends true
	? T extends { readonly _or: infer O extends KRequiredValidator }
		? O
		: never
	: T['_req']

export type KNativeFields<F extends KFields> = { [K in keyof F]: F[K]['validator'] }

export type KOutputFields<F extends KFields> = { [K in keyof F]: OutputNativeOf<F[K]> }

export type KAnyDiffers<F extends KFields> = true extends F[keyof F]['_d'] ? true : false

export type KAnyTransform<F extends KFields> = true extends F[keyof F]['_t'] ? true : false

/** Output of an object that holds a default or transform somewhere: a defaulted field is required. */
export type KObjectOutput<F extends KFields> = Flat<
	{
		[K in keyof F as KOptionalOutput<F[K]> extends true ? K : never]?: Exclude<
			F[K]['_output'],
			undefined
		>
	} & { [K in keyof F as KOptionalOutput<F[K]> extends true ? never : K]: F[K]['_output'] }
>

/**
 * Whether a field is optional on the output side. `undefined extends any` holds, so an `any` output
 * (`k.any()`) reads the output-side native validator's optionality instead of its value type.
 */
export type KOptionalOutput<S extends KType> = 0 extends 1 & S['_output']
	? OutputNativeOf<S>['isOptional'] extends 'optional'
		? true
		: false
	: undefined extends S['_output']
		? true
		: false

export type Flat<T> = { [K in keyof T]: T[K] }
