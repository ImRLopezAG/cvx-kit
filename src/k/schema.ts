import type { GenericValidator, VAny, VNull, VUnion } from 'convex/values'
import { compileNative, compileOutput } from './compile'
import type { KIssueInput, KSafeParseResult } from './issues'
import { parseSchema, safeParseSchema, type KPlan } from './parse'
import type {
	KArg,
	KMessage,
	KOp,
	KOutputRequired,
	KRefineOptions,
	KRequiredValidator,
	KNode,
	KType,
	OutputNativeOf,
} from './types'

/**
 * An immutable chain record. A root has `prev === null` and a kind op; every chained call allocates one
 * record pointing at its predecessor. Nothing is compiled until `validator`, `outputValidator` or a
 * parse first needs it; each product is memoised in its own pre-declared slot.
 *
 * Type arguments: `Out` the parsed output, `R` the required native validator, `D` whether a default or
 * transform sits inside, `N` the input-side native validator (`R` unless the chain is optional or
 * defaulted), `T` whether a transform or pipe sits inside.
 */
export abstract class KSchema<
	Out = any,
	R extends KRequiredValidator = KRequiredValidator,
	D extends boolean = false,
	N extends GenericValidator = R,
	T extends boolean = false,
> implements KType {
	declare readonly _output: Out
	declare readonly _input: N['type']
	declare readonly _req: R
	declare readonly _d: D
	declare readonly _t: T
	/** Required output-side native validator; read only when `D` is true. */
	declare readonly _or: KRequiredValidator
	/** Output-side native validator; read only when `D` is true. */
	declare readonly _oo: GenericValidator
	readonly prev: KNode | null
	readonly op: KOp
	readonly arg: KArg
	readonly message: KMessage
	/** Memo slot for the input-side native validator. */
	native: GenericValidator | undefined
	/** Memo slot for the output-side native validator. */
	outputNative: GenericValidator | undefined
	/** Memo slot for the parse plan. */
	plan: KPlan | undefined

	constructor(prev: KNode | null, op: KOp, arg: KArg, message: KMessage) {
		this.prev = prev
		this.op = op
		this.arg = arg
		this.message = message
		this.native = undefined
		this.outputNative = undefined
		this.plan = undefined
	}

	get validator(): N {
		// SAFETY: compileNative builds the validator that this record's class declares as N.
		return (this.native ??= compileNative(this)) as N
	}

	get outputValidator(): D extends true ? this['_oo'] : N {
		// SAFETY: compileOutput builds the output-side validator this record's class declares.
		return (this.outputNative ??= compileOutput(this)) as D extends true ? this['_oo'] : N
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

	/** A check on the parsed value; `options.path` attaches the issue below this value (object refinements). */
	refine(check: (value: Out) => boolean, message?: string | KRefineOptions): this {
		return this.link('refine', check, message)
	}

	/** A check that may add several issues through `context.addIssue`. */
	check(check: (value: Out, context: KCheckContext) => void): this {
		return this.link('check', check, undefined)
	}

	/** A type-preserving normaliser; allowed everywhere, including table fields. */
	overwrite(normalise: (value: Out) => Out): this {
		return this.link('overwrite', normalise, undefined)
	}

	/** A type-changing step. Produces a distinct kind that table fields and return shapes reject. */
	transform<O>(map: (value: Out) => O): KTransform<this, O> {
		return new KTransform(this, 'transform', map, undefined)
	}

	/** Parse this schema's output with `target`. Produces a distinct kind, like `transform`. */
	pipe<P extends KType>(target: P): KPipe<this, P> {
		return new KPipe(this, 'pipe', target, undefined)
	}

	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- parse is the decoding boundary for undecoded input.
	parse(input: unknown): Out {
		// SAFETY: a successful walk of this schema produces its declared output.
		return parseSchema(this, input) as Out
	}

	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- safeParse is the decoding boundary for undecoded input.
	safeParse(input: unknown): KSafeParseResult<Out> {
		// SAFETY: a successful walk of this schema produces its declared output.
		return safeParseSchema(this, input) as KSafeParseResult<Out>
	}

	protected link(op: KOp, arg: KArg, message: KMessage): this {
		// SAFETY: every subclass inherits this constructor unchanged, so the record keeps its predecessor's class.
		const Next = this.constructor as new (
			prev: KNode,
			op: KOp,
			arg: KArg,
			message: KMessage,
		) => this
		return new Next(this, op, arg, message)
	}

	protected wrapped<W>(op: KOp): W {
		// SAFETY: the record below a wrapper record is the schema the wrapper's class names as W.
		return wrappedBy(this, op) as W
	}
}

/** The context handed to `.check()`; `addIssue` may be called any number of times. */
export interface KCheckContext {
	addIssue(issue: KIssueInput): void
}

export class KOptional<I extends KType> extends KSchema<
	I['_output'] | undefined,
	I['_req'],
	I['_d'],
	ReturnType<I['_req']['optional']>,
	I['_t']
> {
	declare readonly _or: KOutputRequired<I>
	declare readonly _oo: ReturnType<KOutputRequired<I>['optional']>

	unwrap(): I {
		return this.wrapped<I>('optional')
	}
}

export class KDefault<I extends KType> extends KSchema<
	Exclude<I['_output'], undefined>,
	I['_req'],
	true,
	ReturnType<I['_req']['optional']>,
	I['_t']
> {
	declare readonly _or: KOutputRequired<I>
	declare readonly _oo: KOutputRequired<I>

	unwrap(): I {
		return this.wrapped<I>('default')
	}
}

export class KNullable<I extends KType> extends KSchema<
	I['_output'] | null,
	NullableOf<I['_req']>,
	I['_d'],
	I['validator']['isOptional'] extends 'optional'
		? ReturnType<NullableOf<I['_req']>['optional']>
		: NullableOf<I['_req']>,
	I['_t']
> {
	declare readonly _or: NullableOf<KOutputRequired<I>>
	declare readonly _oo: OutputNativeOf<I>['isOptional'] extends 'optional'
		? ReturnType<NullableOf<KOutputRequired<I>>['optional']>
		: NullableOf<KOutputRequired<I>>

	unwrap(): I {
		return this.wrapped<I>('nullable')
	}
}

export class KTransform<I extends KType, O> extends KSchema<
	O,
	I['_req'],
	true,
	I['validator'],
	true
> {
	declare readonly _or: VAny<O>
	declare readonly _oo: VAny<O>
}

export class KPipe<I extends KType, P extends KType> extends KSchema<
	P['_output'],
	I['_req'],
	true,
	I['validator'],
	true
> {
	declare readonly _or: KOutputRequired<P>
	declare readonly _oo: OutputNativeOf<P>
}

type NullableOf<V extends KRequiredValidator> = VUnion<V['type'] | null, [V, VNull<null>]>

function wrappedBy(node: KNode, op: KOp): KNode {
	let current = node
	while (current.op !== op) current = prevOf(current)
	return prevOf(current)
}

function prevOf(node: KNode): KNode {
	if (node.prev === null) throw new Error(`k: no '${node.op}' wrapper to unwrap`)
	return node.prev
}
