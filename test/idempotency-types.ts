import { Context, Effect, Schema, SchemaGetter } from 'effect'
import { z } from 'zod'
import { effectTransactionalIdempotency, effectSchema, createEffectFoundation } from '../src/effect'
import {
	IdempotencyError,
	transactionalIdempotency,
	type IdempotencyInvocation,
} from '../src/idempotency'
import { zodContract } from '../src/contracts'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
type ErrorOf<T> = T extends Effect.Effect<infer _A, infer E, infer _R> ? E : never
type ServicesOf<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never
type SuccessOf<T> = T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never
class Authorization extends Context.Service<Authorization, boolean>()('ReceiptAuthorization') {}
class Lookup extends Context.Service<Lookup, number>()('ReceiptLookup') {}
class Claim extends Context.Service<Claim, string>()('ReceiptClaim') {}
class Fingerprint extends Context.Service<Fingerprint, string>()('ReceiptFingerprint') {}
class Encoder extends Context.Service<Encoder, number>()('ReceiptEncoder') {}
class Decoder extends Context.Service<Decoder, string>()('ReceiptDecoder') {}
class Writer extends Context.Service<Writer, number>()('ReceiptWriter') {}
class AuthorizationFailure {
	readonly _tag = 'AuthorizationFailure'
}
class LookupFailure {
	readonly _tag = 'LookupFailure'
}
class ClaimFailure {
	readonly _tag = 'ClaimFailure'
}
class FingerprintFailure {
	readonly _tag = 'FingerprintFailure'
}
class WriteFailure {
	readonly _tag = 'WriteFailure'
}
const codec = effectSchema(
	Schema.Number.pipe(
		Schema.decodeTo(Schema.String, {
			decode: SchemaGetter.transformEffect((number) =>
				Decoder.pipe(Effect.map((prefix) => prefix + number)),
			),
			encode: SchemaGetter.transformEffect((_text) => Encoder),
		}),
	),
)
const adapter = effectTransactionalIdempotency({
	final: { replayResult: codec, encode: codec.encode },
	authorize: () =>
		Effect.gen(function* () {
			const allowed = yield* Authorization
			if (!allowed) return yield* Effect.fail(new AuthorizationFailure())
		}),
	lookup: () =>
		Effect.gen(function* () {
			const n = yield* Lookup
			if (n < 0) return yield* Effect.fail(new LookupFailure())
			return []
		}),
	claim: () =>
		Effect.gen(function* () {
			const claim = yield* Claim
			if (!claim) return yield* Effect.fail(new ClaimFailure())
			return claim
		}),
	fingerprint: () =>
		Effect.gen(function* () {
			const fingerprint = yield* Fingerprint
			if (!fingerprint) return yield* Effect.fail(new FingerprintFailure())
			return fingerprint
		}),
	complete: (claim: string) =>
		Effect.gen(function* () {
			const n = yield* Writer
			if (!claim || n < 0) return yield* Effect.fail(new WriteFailure())
		}),
})
declare const invocation: IdempotencyInvocation
const prepared = adapter.prepare(invocation)
type Completion = Extract<SuccessOf<typeof prepared>, { kind: 'execute' }>['complete']
type PrepareErrors = Assert<
	Equal<
		ErrorOf<typeof prepared>,
		IdempotencyError | AuthorizationFailure | LookupFailure | ClaimFailure | FingerprintFailure
	>
>
type PrepareServices = Assert<
	Equal<ServicesOf<typeof prepared>, Authorization | Lookup | Claim | Fingerprint>
>
type CompleteErrors = Assert<
	Equal<ErrorOf<ReturnType<Completion>>, Schema.SchemaError | WriteFailure>
>
type CompleteServices = Assert<Equal<ServicesOf<ReturnType<Completion>>, Encoder | Writer>>
type ReplayServices = Assert<
	Equal<ServicesOf<ReturnType<typeof adapter.replayResult.decode>>, Decoder>
>
type ReplayErrors = Assert<
	Equal<ErrorOf<ReturnType<typeof adapter.replayResult.decode>>, Schema.SchemaError>
>
type ReplayConcrete = Assert<Equal<typeof adapter.replayResult, typeof codec>>

const create = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
	},
	checkPermission: () => undefined,
	writeAudit: () => undefined,
}).Command
const commands = create({
	context: (host: { receipt: IdempotencyInvocation }) => host,
	operations: ({ command }) => ({
		save: command({
			input: z.string(),
			result: z.number().transform(String),
			replayResult: adapter.replayResult,
			prepare: (context): ReturnType<typeof adapter.prepare> => adapter.prepare(context.receipt),
			classification: 'business',
			handler: (input) => input.length,
			audit: () => null,
		}),
	}),
})
const execution = commands.exec('save', 'title', { receipt: invocation })
type ExecutionErrors = Assert<
	Equal<
		ErrorOf<typeof execution>,
		| IdempotencyError
		| AuthorizationFailure
		| LookupFailure
		| ClaimFailure
		| FingerprintFailure
		| Schema.SchemaError
		| WriteFailure
	>
>
type ExecutionServices = Assert<
	Equal<
		ServicesOf<typeof execution>,
		Authorization | Lookup | Claim | Fingerprint | Encoder | Decoder | Writer
	>
>
type ExecutionSuccess = Assert<Equal<SuccessOf<typeof execution>, string>>
const assertions: [
	PrepareErrors,
	PrepareServices,
	CompleteErrors,
	CompleteServices,
	ReplayServices,
	ReplayErrors,
	ReplayConcrete,
	ExecutionErrors,
	ExecutionServices,
	ExecutionSuccess,
] = [true, true, true, true, true, true, true, true, true, true]
void assertions
declare const completion: Completion
// @ts-expect-error final encoding accepts final output, not its persisted numeric wire representation
completion(3)
// @ts-expect-error raw transport cannot substitute for invocation-private trusted capture
adapter.prepare({
	identity: { operation: 'save', scope: 'trusted', key: 'retry' },
	versions: { operation: '1', contract: '1', binding: '1', fingerprintPolicy: '1' },
})
const mismatchedReplay = {
	input: z.string(),
	result: z.number().transform(String),
	replayResult: z.number(),
	classification: 'business',
	handler: (input: string) => input.length,
	audit: () => null,
}
const invalidFinal = create({
	context: (host: { receipt: IdempotencyInvocation }) => host,
	operations: ({ command }) => ({
		// @ts-expect-error replay final number cannot substitute for fresh final string
		bad: command(mismatchedReplay),
	}),
})
void invalidFinal

const neutral = transactionalIdempotency({
	final: {
		replayResult: zodContract(z.string().transform(Number)),
		encode: (result: number) => String(result),
	},
	authorize: async () => undefined,
	lookup: () => [],
	fingerprint: (bytes) => bytes,
	claim: () => 'claim',
	complete: (claim: string) => {
		claim.toUpperCase()
	},
})
type NeutralFinal = Assert<
	Equal<
		Parameters<
			Extract<Awaited<ReturnType<typeof neutral.prepare>>, { kind: 'execute' }>['complete']
		>[0],
		number
	>
>
const neutralAssertion: NeutralFinal = true
void neutralAssertion
transactionalIdempotency({
	final: {
		replayResult: zodContract(z.string().transform(Number)),
		// @ts-expect-error paired codec must encode the final number to the decoder's string wire input
		encode: (result: number) => result,
	},
	authorize: () => undefined,
	lookup: () => [],
	fingerprint: (bytes) => bytes,
	claim: () => 'claim',
	complete: () => undefined,
})
