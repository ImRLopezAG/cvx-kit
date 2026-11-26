import type { GenericValidator } from 'convex/values'
import { compileNative } from './compile'
import type { KArg, KKind, KOp, KRefinement, KType, NativeOf } from './types'

/**
 * An immutable chain record. A root has `prev === null` and a kind op; every chained call allocates one
 * record pointing at its predecessor. Nothing is compiled until `validator` is first read.
 */
export abstract class KSchema<Out = any, In = Out> implements KType {
	declare readonly _kind: KKind
	declare readonly _output: Out
	declare readonly _input: In
	readonly prev: KSchema | null
	readonly op: KOp
	readonly arg: KArg
	readonly message: string | undefined
	/** Memo slot for the input-side native validator; `undefined` until `validator` is read. */
	native: GenericValidator | undefined

	constructor(prev: KSchema | null, op: KOp, arg: KArg, message: string | undefined) {
		this.prev = prev
		this.op = op
		this.arg = arg
		this.message = message
		this.native = undefined
	}

	get validator(): NativeOf<this> {
		// SAFETY: compileNative builds the validator NativeOf derives from this record's kind and chain.
		return (this.native ??= compileNative(this)) as NativeOf<this>
	}

	optional(): KOptional<this> {
		return new KOptional(this, 'optional', undefined, undefined)
	}

	nullable(): KNullable<this> {
		return new KNullable(this, 'nullable', undefined, undefined)
	}

	default(value: Exclude<this['_output'], undefined>): KDefault<this> {
		// SAFETY: a default is a Convex value of this schema's output type.
		return new KDefault(this, 'default', value as KArg, undefined)
	}

	refine(check: (value: this['_output']) => boolean, message?: string): this {
		// SAFETY: the refinement is only ever called with values this schema produced.
		return this.link('refine', check as KRefinement, message)
	}

	protected link(op: KOp, arg: KArg, message: string | undefined): this {
		// SAFETY: every subclass inherits this constructor unchanged, so the record keeps its predecessor's class.
		const Next = this.constructor as new (
			prev: KSchema,
			op: KOp,
			arg: KArg,
			message: string | undefined,
		) => this
		return new Next(this, op, arg, message)
	}
}

export class KOptional<I extends KType> extends KSchema<
	I['_output'] | undefined,
	I['_input'] | undefined
> {
	declare readonly _kind: 'optional'
	declare readonly _def: I
}

export class KNullable<I extends KType> extends KSchema<I['_output'] | null, I['_input'] | null> {
	declare readonly _kind: 'nullable'
	declare readonly _def: I
}

export class KDefault<I extends KType> extends KSchema<
	Exclude<I['_output'], undefined>,
	I['_input'] | undefined
> {
	declare readonly _kind: 'default'
	declare readonly _def: I
}
