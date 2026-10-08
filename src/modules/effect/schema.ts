/* oxlint-disable anti-slop/no-unknown-parameters -- Explicit schema decoder boundaries validate untrusted transport input. */
import { Effect, Schema } from 'effect'
import type {
	ContractSchema,
	ContractOutput,
	Decoder,
	LegacyParser,
	NeutralSchema,
	ValidationIssue,
} from '../contracts/contract'
import { decodeContract } from '../contracts/contract'

export class ContractValidationError {
	readonly _tag = 'ContractValidationError'
	constructor(readonly issues: readonly ValidationIssue[]) {}
}
export interface EffectDecoder<Input, Output, Error = never, Requirements = never> extends Decoder<
	Input,
	Output,
	Effect.Effect<Output, Error, Requirements>
> {
	readonly kind: 'effect-contract'
}
/** Explicit custom decoders preserve their exact typed error and service channels. */
export function effectContract<Input, Output, Error = never, Requirements = never>(
	decode: (value: unknown) => Effect.Effect<Output, Error, Requirements>,
): EffectDecoder<Input, Output, Error, Requirements> {
	return { kind: 'effect-contract', decode }
}
/** Encoding requirements remain independent of the decoder's requirements. */
export function effectSchema<const S extends Schema.Constraint>(schema: S) {
	return {
		...effectContract<S['Encoded'], S['Type'], Schema.SchemaError, S['DecodingServices']>(
			Schema.decodeUnknownEffect(schema),
		),
		schema,
		encode: Schema.encodeEffect(schema),
	}
}
/** The service-free bridge cannot erase decoder requirements. */
export function effectStandardSchema<const S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
	return Schema.toStandardSchemaV1(schema)
}
export type ContractDecoderError<S> =
	S extends EffectDecoder<unknown, unknown, infer Error, unknown>
		? Error
		: S extends LegacyParser
			? never
			: S extends ContractSchema
				? ContractValidationError
				: never
export type ContractDecoderRequirements<S> =
	S extends EffectDecoder<unknown, unknown, unknown, infer Requirements> ? Requirements : never

/** Decode input, fresh results, and final replay values within the current Effect scope. */
export function decodeEffectContract<S extends ContractSchema>(
	schema: S,
	value: unknown,
): Effect.Effect<ContractOutput<S>, ContractDecoderError<S>, ContractDecoderRequirements<S>> {
	const decoded = Effect.suspend(() => {
		if ('kind' in schema && schema.kind === 'effect-contract') {
			// SAFETY: only the explicit optional adapter exposes this discriminator.
			return schema.decode(value) as Effect.Effect<unknown, unknown, unknown>
		}
		// SAFETY: the Effect discriminator was excluded; ordinary adapters return validation results.
		return Effect.promise(() => decodeContract(schema as NeutralSchema, value)).pipe(
			Effect.flatMap((result) => {
				if (!result.issues) return Effect.succeed(result.value)
				const error = new ContractValidationError(result.issues)
				// Legacy parsers have always exposed validation throws as defects.
				return 'parse' in schema ? Effect.die(error) : Effect.fail(error)
			}),
		)
	})
	// SAFETY: conditional channels correspond to the explicit Effect branch or neutral validation branch.
	return decoded as Effect.Effect<
		ContractOutput<S>,
		ContractDecoderError<S>,
		ContractDecoderRequirements<S>
	>
}
