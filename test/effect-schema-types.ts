import { Context, Effect, Schema } from 'effect'
import {
	effectContract,
	effectSchema,
	effectStandardSchema,
	decodeEffectContract,
	type ContractDecoderError,
	type ContractDecoderRequirements,
} from '../src/modules/effect/schema'
import {
	effectOperationFactory,
	type EffectOperationError,
	type EffectOperationRequirements,
} from '../src/modules/effect/operation'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
class DecoderService extends Context.Service<DecoderService, string>()('U1DecoderService') {}
class EncoderService extends Context.Service<EncoderService, string>()('U1EncoderService') {}
class DecodeFailure {
	readonly _tag = 'DecodeFailure'
}
declare const serviceSchema: Schema.Codec<string, number, DecoderService, EncoderService>
const codec = effectSchema(serviceSchema)
const decoded = decodeEffectContract(codec, 2)
const encoded = codec.encode('title')
const custom = effectContract<number, string, DecodeFailure, DecoderService>(() =>
	DecoderService.pipe(Effect.andThen(Effect.fail(new DecodeFailure()))),
)
const helper = effectOperationFactory<{}>()
const read = helper.query({ input: custom, result: codec, handler: (title) => title.length })
const assertions: [
	Assert<Equal<Effect.Success<typeof decoded>, string>>,
	Assert<Equal<Effect.Error<typeof decoded>, Schema.SchemaError>>,
	Assert<Equal<Effect.Services<typeof decoded>, DecoderService>>,
	Assert<Equal<Effect.Services<typeof encoded>, EncoderService>>,
	Assert<Equal<ContractDecoderError<typeof custom>, DecodeFailure>>,
	Assert<Equal<ContractDecoderRequirements<typeof custom>, DecoderService>>,
	Assert<Equal<EffectOperationError<typeof read>, DecodeFailure | Schema.SchemaError>>,
	Assert<Equal<EffectOperationRequirements<typeof read>, DecoderService>>,
] = [true, true, true, true, true, true, true, true]
void assertions
// @ts-expect-error service-bearing schema cannot enter the service-free Standard bridge
effectStandardSchema(serviceSchema)
effectStandardSchema(Schema.String)
// @ts-expect-error decoder service cannot be silently dropped at execution
void Effect.runPromise(decoded)
