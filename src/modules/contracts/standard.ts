import type {
	ContractInput,
	ContractOutput,
	Decoder,
	StandardSchema,
	ValidationResult,
} from './contract'
import type { z } from 'zod'

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

/** Zod's Standard bridge probes sync first; safeParseAsync executes transforms once. */
export function zodContract<const S extends z.ZodType>(
	schema: S,
): Decoder<z.input<S>, z.output<S>, Promise<ValidationResult<z.output<S>>>> & {
	readonly kind: 'contract'
	readonly schema: S
} {
	return {
		kind: 'contract',
		schema,
		decode: async (value) => {
			const result = await schema.safeParseAsync(value)
			return result.success ? { value: result.data } : { issues: result.error.issues }
		},
	}
}
