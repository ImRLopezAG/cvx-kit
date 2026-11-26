import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { GenericValidator, VAny, VNull, VUnion } from 'convex/values'
import { compileNative, compileOutput } from './compile'
import type { KIssueInput, KSafeParseResult } from './issues'
import { parseSchema, safeParseSchema, type KPlan } from './parse'
import { standardProps } from './standard'
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
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- the merged interface only adds methods that cvx-kit/zod installs on the prototype.
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

	/**
	 * A check on the parsed value; `options.path` attaches the issue below this value (object
	 * refinements). A type-guard predicate narrows the output, and the input when no transform sits inside.
	 */
	refine<U extends Out>(
		check: (value: Out) => value is U,
		message?: string | KRefineOptions,
	): KNarrowed<this, U>
	refine(check: (value: Out) => boolean, message?: string | KRefineOptions): this
	refine(check: (value: Out) => boolean, message?: string | KRefineOptions): this {
		return this.link('refine', check, frozenMessage(message))
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

	/** A description for JSON Schema and tooling; it changes neither the validators nor parsing. */
	describe(text: string): this {
		return this.link('describe', text, undefined)
	}

	/** The nearest description declared on this chain. */
	get description(): string | undefined {
		return descriptionOf(this)
	}

	/** Standard Schema v1, so contracts and form libraries consume `k` schemas directly. */
	get '~standard'(): StandardSchemaV1.Props<N['type'], Out> {
		return standardProps(this)
	}

	protected link(op: KOp, arg: KArg, message: KMessage): this {
		// SAFETY: every subclass inherits this constructor unchanged, so the record keeps its predecessor's class.
		const Next = this.constructor as new (
			prev: KNode,
			op: KOp,
			arg: KArg,
			message: KMessage,
		) => this
		const next = new Next(this, op, arg, message)
		// link only records checks, normalisers and descriptions: its native shape is unchanged.
		// Private filter boundaries use an any root with a lazy native accessor. Do not force it here.
		if (this.op !== 'any') next.native = this.native
		return next
	}

	protected wrapped<W>(op: KOp): W {
		// SAFETY: the record below a wrapper record is the schema the wrapper's class names as W.
		return wrappedBy(this, op) as W
	}
}

/**
 * A schema whose `refine` took a type guard: the same chain with its output (and, without a transform,
 * its input) narrowed to `U`. An intersection, not an `Omit`, so methods returning `this` keep the
 * narrowing; the narrowed members come first, so `parse` resolves to the narrowed overload.
 */
export type KNarrowed<S extends KType, U> = KNarrowing<S, U, S['_t']> & S

/** The members a type-guard `refine` narrows; an interface, so schemas compare by its variance. */
export interface KNarrowing<S extends KType, U, T extends boolean> {
	readonly _output: U
	readonly _input: T extends true ? S['validator']['type'] : U
	readonly validator: T extends true ? S['validator'] : S['validator'] & { readonly type: U }
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- parse is the decoding boundary for undecoded input.
	parse(input: unknown): U
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- safeParse is the decoding boundary for undecoded input.
	safeParse(input: unknown): KSafeParseResult<U>
	optional(): KNarrowedWrapper<KOptional<S>, U | undefined, T> & KOptional<S>
	nullable(): KNarrowedWrapper<KNullable<S>, U | null, T> & KNullable<S>
}

/** `optional()` or `nullable()` of a narrowed schema: the wrapper with its output and input retyped. */
interface KNarrowedWrapper<W extends KType, U, T extends boolean> {
	readonly _output: U
	readonly validator: T extends true ? W['validator'] : W['validator'] & { readonly type: U }
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- parse is the decoding boundary for undecoded input.
	parse(input: unknown): U
}

/** The context handed to `.check()`; `addIssue` may be called any number of times. */
export interface KCheckContext {
	addIssue(issue: KIssueInput): void
}

declare global {
	/**
	 * Methods that optional cvx-kit entries add to every `k` schema; `cvx-kit/zod` adds `toZod()`. Empty
	 * in core, so core declarations never name an optional peer's types.
	 */
	interface CvxKitSchemaMethods {}
}

/* oxlint-disable no-unused-vars -- A merged declaration must repeat the class's type parameters. */
/** Adds the optional entries' methods to the class type; the entries install them at runtime. */
export interface KSchema<
	Out = any,
	R extends KRequiredValidator = KRequiredValidator,
	D extends boolean = false,
	N extends GenericValidator = R,
	T extends boolean = false,
> extends CvxKitSchemaMethods {}
/* oxlint-enable no-unused-vars */

/**
 * `.toZod()` exists only once `cvx-kit/zod` is imported, which also adds its type. Until then this stub
 * names the entry; core declarations stay free of Zod types.
 */
Object.defineProperty(KSchema.prototype, 'toZod', {
	value: missingZodEntry,
	writable: true,
	configurable: true,
})

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

/** Freezes a refine options object and its path in place, like every other container a record holds. */
function frozenMessage(message: string | KRefineOptions | undefined): KMessage {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- refine takes either its message or an options object.
	if (message === undefined || typeof message === 'string') return message
	if (message.path !== undefined) Object.freeze(message.path)
	return Object.freeze(message)
}

function missingZodEntry(): never {
	throw new Error("k: .toZod() needs the Zod interop entry; add `import 'cvx-kit/zod'` first")
}

function descriptionOf(node: KNode): string | undefined {
	for (let current: KNode | null = node; current !== null; current = current.prev) {
		if (current.op === 'describe') {
			// SAFETY: a describe record stores its text as the record argument.
			return current.arg as string
		}
	}
	return undefined
}

function wrappedBy(node: KNode, op: KOp): KNode {
	let current = node
	while (current.op !== op && !(op === 'optional' && current.op === 'partial'))
		current = prevOf(current)
	return prevOf(current)
}

function prevOf(node: KNode): KNode {
	if (node.prev === null) throw new Error(`k: no '${node.op}' wrapper to unwrap`)
	return node.prev
}
