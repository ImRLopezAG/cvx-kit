import type {
	ContractInput,
	ContractOutput,
	Decoder,
	StandardSchema,
	ValidationResult,
} from './contract'
import type { KSafeParseResult } from '../../k/issues'
import type { KType } from '../../k/types'

/** Standard Schema validation executes exactly the validator supplied by its author. */
export function standardContract<const S extends StandardSchema<unknown, unknown>>(
	schema: S,
): Decoder<
	ContractInput<S>,
	ContractOutput<S>,
	ValidationResult<ContractOutput<S>> | Promise<ValidationResult<ContractOutput<S>>>
> & { readonly kind: 'contract'; readonly schema: S } {
	return {
		kind: 'contract',
		schema,
		// SAFETY: structural Standard Schema inference associates validate's output with S.
		decode: (value) =>
			schema['~standard'].validate(value) as
				| ValidationResult<ContractOutput<S>>
				| Promise<ValidationResult<ContractOutput<S>>>,
	}
}

/**
 * A `k` schema as a contract: callers supply its input type (`k.input`, defaults optional, before any
 * transform) and the handler receives its output (`k.infer`). Decoding is synchronous; a failure is a
 * validation result whose issues carry the KTD6 `path`, `code` and `message`.
 */
export function kContract<const S extends KType>(
	schema: S,
): Decoder<S['validator']['type'], S['_output'], ValidationResult<S['_output']>> & {
	readonly kind: 'contract'
	readonly schema: S
} {
	// SAFETY: every KType at runtime is a KSchema record, which carries safeParse.
	const parser = schema as S & {
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Contracts decode undecoded transport input.
		safeParse: (value: unknown) => KSafeParseResult<S['_output']>
	}
	return {
		kind: 'contract',
		schema,
		decode: (value) => {
			const result = parser.safeParse(value)
			return result.success ? { value: result.data } : { issues: result.issues }
		},
	}
}
