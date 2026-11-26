import type { GenericValidator, VNull, VUnion } from 'convex/values'
import { compileNative } from './compile'
import type { KArg, KOp, KRefinement, KRequiredValidator, KType } from './types'

/**
 * An immutable chain record. A root has `prev === null` and a kind op; every chained call allocates one
 * record pointing at its predecessor. Nothing is compiled until `validator` is first read.
 *
 * Type arguments: `Out` the parsed output, `R` the required native validator, `D` whether a default
 * sits inside, `N` the input-side native validator (`R` unless the chain is optional or defaulted).
 */
export abstract class KSchema<
	Out = any,
	R extends KRequiredValidator = KRequiredValidator,
	D extends boolean = false,
	N extends GenericValidator = R,
> implements KType {
	declare readonly _output: Out
	declare readonly _input: N['type']
	declare readonly _req: R
	declare readonly _d: D
	readonly prev: AnySchema | null
	readonly op: KOp
	readonly arg: KArg
	readonly message: string | undefined
	/** Memo slot for the input-side native validator; `undefined` until `validator` is read. */
	native: GenericValidator | undefined

	constructor(prev: AnySchema | null, op: KOp, arg: KArg, message: string | undefined) {
		this.prev = prev
		this.op = op
		this.arg = arg
		this.message = message
		this.native = undefined
	}

	get validator(): N {
		// SAFETY: compileNative builds the validator that this record's class declares as N.
		return (this.native ??= compileNative(this)) as N
	}

	optional(): KOptional<this> {
		return new KOptional(this, 'optional', undefined, undefined)
	}

	nullable(): KNullable<this> {
		return new KNullable(this, 'nullable', undefined, undefined)
	}

	default(value: Exclude<Out, undefined>): KDefault<this> {
		// SAFETY: a default is a Convex value of this schema's output type.
		return new KDefault(this, 'default', value as KArg, undefined)
	}

	refine(check: (value: Out) => boolean, message?: string): this {
		// SAFETY: the refinement is only ever called with values this schema produced.
		return this.link('refine', check as KRefinement, message)
	}

	protected link(op: KOp, arg: KArg, message: string | undefined): this {
		// SAFETY: every subclass inherits this constructor unchanged, so the record keeps its predecessor's class.
		const Next = this.constructor as new (
			prev: AnySchema,
			op: KOp,
			arg: KArg,
			message: string | undefined,
		) => this
		return new Next(this, op, arg, message)
	}
}

export type AnySchema = KSchema<any, any, any, any>

export class KOptional<I extends KType> extends KSchema<
	I['_output'] | undefined,
	I['_req'],
	I['_d'],
	ReturnType<I['_req']['optional']>
> {}

export class KDefault<I extends KType> extends KSchema<
	Exclude<I['_output'], undefined>,
	I['_req'],
	true,
	ReturnType<I['_req']['optional']>
> {}

export class KNullable<I extends KType> extends KSchema<
	I['_output'] | null,
	NullableOf<I>,
	I['_d'],
	I['validator']['isOptional'] extends 'optional'
		? ReturnType<NullableOf<I>['optional']>
		: NullableOf<I>
> {}

type NullableOf<I extends KType> = VUnion<I['_req']['type'] | null, [I['_req'], VNull<null>]>
