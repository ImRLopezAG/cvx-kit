/* oxlint-disable anti-slop/no-unknown-parameters -- These explicit validation boundaries receive untrusted transport values before schema decoding. */
/** Structural contracts keep the optional Effect peer out of this module. */
export interface StandardSchema<Input = unknown, Output = Input> {
	readonly '~standard': {
		readonly version: 1
		readonly vendor: string
		readonly types?: { readonly input: Input; readonly output: Output }
		readonly validate: (
			value: unknown,
		) => ValidationResult<Output> | Promise<ValidationResult<Output>>
	}
}
export interface ValidationIssue {
	readonly message: string
	readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[]
}
export type ValidationResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: readonly ValidationIssue[] }
export interface LegacyParser<Output = unknown> {
	readonly parse: (value: unknown) => Output
	readonly parseAsync?: (value: unknown) => Promise<Output>
}
/** Decode execution is an opaque channel here; optional adapters give it concrete semantics. */
export interface Decoder<Input = unknown, Output = unknown, Execution = unknown> {
	readonly kind: 'contract' | 'effect-contract'
	readonly types?: { readonly input: Input; readonly output: Output }
	readonly decode: (value: unknown) => Execution
}
export type ContractSchema = LegacyParser | StandardSchema<unknown, unknown> | Decoder
export type NeutralSchema =
	| LegacyParser
	| StandardSchema<unknown, unknown>
	| (Decoder<unknown, unknown, ValidationResult<unknown> | Promise<ValidationResult<unknown>>> & {
			readonly kind: 'contract'
	  })
export type ContractInput<S> =
	S extends Decoder<infer Input, unknown, unknown>
		? Input
		: S extends StandardSchema<infer Input, unknown>
			? Input
			: S extends { readonly _input: infer Input }
				? Input
				: S extends LegacyParser<infer Output>
					? Awaited<Output>
					: never
export type ContractOutput<S> =
	S extends Decoder<unknown, infer Output, unknown>
		? Output
		: S extends StandardSchema<unknown, infer Output>
			? Output
			: S extends LegacyParser<infer Output>
				? Awaited<Output>
				: never
export type ContractExecution<S> =
	S extends Decoder<unknown, unknown, infer Execution> ? Execution : never

/** Validation failures are values. Throws/rejections are deliberately left as defects. */
export async function decodeContract<S extends NeutralSchema>(
	schema: S,
	value: unknown,
): Promise<ValidationResult<ContractOutput<S>>> {
	let result: ValidationResult<unknown>
	if ('kind' in schema) result = await schema.decode(value)
	else if ('parse' in schema)
		result = { value: await (schema.parseAsync ? schema.parseAsync(value) : schema.parse(value)) }
	else result = await schema['~standard'].validate(value)
	// SAFETY: each branch returns the output associated with this exact schema.
	return result as ValidationResult<ContractOutput<S>>
}

/** Independent final and wire contracts never reuse the fresh-result transform. */
export function operationContract<
	const Input extends ContractSchema,
	const Result extends ContractSchema,
	const Replay extends ContractSchema,
	const Wire extends ContractSchema,
	const Definition extends object,
>(
	definition: Definition & {
		input: Input
		result: Result
		replayResult: Replay & (ContractOutput<Replay> extends ContractOutput<Result> ? unknown : never)
		wire: { project: (value: ContractOutput<Result>) => ContractInput<Wire>; schema: Wire }
	},
) {
	return definition
}
