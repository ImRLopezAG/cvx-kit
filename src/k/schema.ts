import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { GenericValidator, VAny, VNull, VUnion } from 'convex/values'
import { compileNative, compileOutput } from './compile'
import type { KIssue, KIssueInput, KSafeParseResult } from './issues'
import { refineMessage } from './messages'
import { idPath, parseSchema, safeParseSchema, type KPlan } from './parse'
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

	default(value: Exclude<Out, undefined> | (() => Exclude<Out, undefined>)): KDefault<this> {
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
	// oxlint-disable-next-line anti-slop/no-unknown-returns -- refinements accept any truthy callback result, including user-defined types.
	refine(check: (value: Out) => unknown, message?: string | KRefineOptions): this
	// oxlint-disable-next-line anti-slop/no-unknown-returns -- refinements accept any truthy callback result, including user-defined types.
	refine(check: (value: Out) => unknown, message?: string | KRefineOptions): this {
		return this.link('refine', check, refineMessage(message))
	}

	/** A check that may add several issues through `context.addIssue`. */
	check(check: (value: Out, context: KCheckContext) => void): this {
		return this.link('check', check, undefined)
	}

	/** A type-preserving normaliser; allowed everywhere, including table fields. */
	overwrite(normalise: (value: Out) => Out): this {
		return this.link('overwrite', normalise, undefined)
	}

	/**
	 * A type-changing step. Produces a distinct kind that table fields and return shapes reject. A
	 * callback that declares a second parameter may call `context.addIssue(...)`: the parse then fails
	 * with those issues and the return value is ignored (return `k.NEVER`).
	 */
	transform<O>(map: (value: Out, context: KCheckContext) => O): KTransform<this, O> {
		return new KTransform(this, 'transform', map, undefined)
	}

	/** Parse this schema's output with `target`. Produces a distinct kind, like `transform`. */
	pipe<P extends KType>(target: P): KPipe<this, P> {
		assertSchema(target, 'pipe target')
		return new KPipe(this, 'pipe', target, undefined)
	}

	/**
	 * Zod's `.catch`: when this schema reports issues, parse succeeds with `fallback` instead (a function
	 * receives `{ issues, input }`). The fallback is not validated. Convex sees `v.any()` on the input
	 * side, so the kit runs the wrapped schema in full. Rejected on table fields and in `returns`, on a
	 * discriminated-union option or discriminator (put it on the union), and around any `k.id`: only
	 * Convex can check an id's table, and catch removes Convex's check.
	 */
	catch(fallback: Out | ((context: KCatchContext) => Out)): KCatch<this> {
		const id = idPath(this)
		if (id !== undefined)
			throw new Error(
				`k: .catch() cannot wrap a schema holding k.id (${id === '' ? 'the schema itself' : `at '${id}'`}): catch replaces Convex's argument validation for this value with v.any(), and an id's table can only be checked by Convex. Catch the surrounding non-id fields instead, or validate the id in the handler with ctx.db.normalizeId`,
			)
		// SAFETY: a fallback is this schema's output, a Convex value, or a callback producing one.
		const record: KNode = new KTransform(this, 'catch', fallback as KArg, undefined)
		// SAFETY: KCatch declares types only; KTransform lends the runtime class, as behaviour keys on the op.
		return record as KCatch<this>
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

	/**
	 * `parse` as the kit's boundaries run it: an object that declares no unknown-key policy rejects
	 * unknown keys at every depth, as Convex's own validator does, where `parse` strips them.
	 */
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the boundary parse decodes undecoded input.
	'~parseStrict'(input: unknown): Out {
		// SAFETY: a successful walk of this schema produces its declared output.
		return parseSchema(this, input, false) as Out
	}

	/** `safeParse` as the kit's boundaries run it; see `~parseStrict`. */
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the boundary parse decodes undecoded input.
	'~safeParseStrict'(input: unknown): KSafeParseResult<Out> {
		// SAFETY: a successful walk of this schema produces its declared output.
		return safeParseSchema(this, input, false) as KSafeParseResult<Out>
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
	get '~standard'(): StandardSchemaV1.Props<N['type'], Out> & CvxKitStandardProps {
		// SAFETY: `jsonSchema` is present exactly when cvx-kit/json-schema, which declares it on
		// CvxKitStandardProps, is imported and has installed its converter.
		return standardProps(this) as StandardSchemaV1.Props<N['type'], Out> & CvxKitStandardProps
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

/** Check only the immediate declaration, without compiling or visiting children. */
export function assertSchema(value: KNode, location: string): void {
	// A schema from a second installed copy of the package is another class with the same record shape.
	if (value instanceof KSchema || (value?.op !== undefined && 'prev' in value && 'native' in value))
		return
	throw new TypeError(`k: ${location} must be a k schema`)
}

/**
 * A schema whose `refine` took a type guard: the same chain with its output (and, without a transform,
 * its input) narrowed to `U`. An intersection, not an `Omit`, so methods returning `this` keep the
 * narrowing; the narrowed members come first, so `parse` resolves to the narrowed overload.
 *
 * `optional()` and `nullable()` keep the output narrowed but not the native validator's type, which
 * plain objects read for `k.infer`; write the guard on the wrapped schema to narrow both
 * (`.optional().refine((v): v is U | undefined => …)`). Narrowing them too costs about 6% more type
 * instantiations on the app benchmark, because the wrappers make every schema class non-covariant.
 */
export type KNarrowed<S extends KType, U> = KNarrowing<S, U, S['_t']> & S

/** The members a type-guard `refine` narrows; an interface, so schemas compare by its variance. */
export interface KNarrowing<S extends KType, U, T extends boolean> {
	readonly _output: U
	readonly _input: T extends true ? S['validator']['type'] : U
	readonly validator: T extends true ? S['validator'] : S['validator'] & { readonly type: U }
	readonly _req: T extends true ? S['_req'] : KNarrowedRequired<S['_req'], U>
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- parse is the decoding boundary for undecoded input.
	parse(input: unknown): U
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- safeParse is the decoding boundary for undecoded input.
	safeParse(input: unknown): KSafeParseResult<U>
}

/**
 * The required native validator of a type-guarded schema, with its value type narrowed to `U` (and its
 * `optional()` to `U | undefined`), so containers that read native types (arrays, records, unions,
 * optional fields) keep the narrowing. A type-level brand only: the runtime validator is unchanged.
 */
export type KNarrowedRequired<V extends KRequiredValidator, U> = V & {
	readonly type: U
	optional(): ReturnType<V['optional']> & { readonly type: U | undefined }
}

/**
 * Any `k` schema, as a parameter type for helpers that take one: unlike the structural `KType`, it has
 * the schema methods such helpers call (`optional()`, `nullable()`, `parse`, `outputValidator`). Their
 * results are `AnyKSchema` and `any`, so every schema is assignable to it; a helper that must keep the
 * exact schema type takes `S extends KType` and names the result (`KOptional<S>`) itself.
 */
export interface AnyKSchema extends KType {
	readonly outputValidator: GenericValidator
	readonly description: string | undefined
	optional(): AnyKSchema
	nullable(): AnyKSchema
	describe(text: string): AnyKSchema
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- parse is the decoding boundary for undecoded input.
	parse(input: unknown): any
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- safeParse is the decoding boundary for undecoded input.
	safeParse(input: unknown): KSafeParseResult<any>
}

/** The context a `.catch()` fallback function receives: the issues the wrapped schema reported and the input. */
export interface KCatchContext {
	readonly issues: readonly KIssue[]
	readonly input: any
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
	/**
	 * Members that optional cvx-kit entries add to every schema's `~standard` props;
	 * `cvx-kit/json-schema` adds Standard JSON Schema's `jsonSchema`. Empty in core.
	 */
	interface CvxKitStandardProps {}
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

	/** The schema below the default, as Zod's `removeDefault()`; the same as `unwrap()`. */
	removeDefault(): I {
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

// A schema with a fallback: natively `v.any()` on input, the wrapped schema on output.
export declare class KCatch<I extends KType> extends KSchema<
	I['_output'],
	VAny<I['validator']['type']>,
	true,
	I['validator']['isOptional'] extends 'optional'
		? VAny<I['validator']['type'], 'optional'>
		: VAny<I['validator']['type']>,
	I['_t']
> {
	declare readonly _or: KOutputRequired<I>
	declare readonly _oo: OutputNativeOf<I>
}

type NullableOf<V extends KRequiredValidator> = VUnion<V['type'] | null, [V, VNull<null>]>

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
