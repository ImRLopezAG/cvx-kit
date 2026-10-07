import { Effect } from 'effect'
import type { ContractInput, ContractOutput, ContractSchema } from '../contracts/contract'
import {
	IdempotencyError,
	idempotencyCanonicalInput,
	idempotencyFingerprint,
	retainedIdempotencyReceipt,
	type IdempotencyIdentity,
	type IdempotencyInvocation,
	type IdempotencyReceipt,
} from '../contracts/idempotency'
import type { CallbackError, CallbackRequirements, EffectValue } from './operation'
import { normalizeEffect } from './normalize'

type Supported<A> = A | PromiseLike<A> | Effect.Effect<A, unknown, unknown>
export type EffectIdempotencyPreparation<Result, Error = never, Requirements = never> =
	| { readonly kind: 'replay'; readonly result: unknown }
	| {
			readonly kind: 'execute'
			readonly complete: (result: Result) => Effect.Effect<void, Error, Requirements>
	  }

/** Callback throws/rejections remain defects; only explicit Effect failures contribute typed channels. */
export function effectTransactionalIdempotency<
	const Replay extends ContractSchema,
	Authorize extends Supported<void>,
	Lookup extends Supported<readonly unknown[]>,
	Fingerprint extends Supported<string>,
	Claim,
	Encode extends Supported<ContractInput<Replay>>,
	Complete extends Supported<void>,
>(configuration: {
	readonly final: {
		readonly replayResult: Replay
		readonly encode: (result: ContractOutput<Replay>) => Encode
	}
	readonly authorize: (invocation: IdempotencyInvocation) => Authorize
	readonly lookup: (identity: IdempotencyIdentity) => Lookup
	readonly fingerprint: (canonicalBytes: string) => Fingerprint
	readonly claim: (identity: IdempotencyIdentity, receipt: IdempotencyReceipt) => Claim
	readonly complete: (claim: EffectValue<Claim>, receipt: IdempotencyReceipt) => Complete
}) {
	type PrepareError = IdempotencyError | CallbackError<Authorize | Lookup | Fingerprint | Claim>
	type PrepareRequirements = CallbackRequirements<Authorize | Lookup | Fingerprint | Claim>
	type CompleteError = CallbackError<Encode | Complete>
	type CompleteRequirements = CallbackRequirements<Encode | Complete>
	type Preparation = EffectIdempotencyPreparation<
		ContractOutput<Replay>,
		CompleteError,
		CompleteRequirements
	>
	return {
		replayResult: configuration.final.replayResult,
		prepare(
			invocation: IdempotencyInvocation,
		): Effect.Effect<Preparation, PrepareError, PrepareRequirements> {
			return Effect.gen(function* () {
				const canonical = yield* protocol(() => idempotencyCanonicalInput(invocation))
				yield* normalizeEffect(() => configuration.authorize(invocation))
				const rows = yield* normalizeEffect(() => configuration.lookup(invocation.identity))
				// SAFETY: Lookup's supported success constraint is the retained-row boundary.
				const retained = yield* protocol(() =>
					retainedIdempotencyReceipt(rows as readonly unknown[], invocation),
				)
				const proposed = yield* normalizeEffect(() => configuration.fingerprint(canonical))
				// SAFETY: Fingerprint's supported success constraint is string.
				const fingerprint = yield* protocol(() =>
					idempotencyFingerprint(proposed as string, retained),
				)
				if (retained) return { kind: 'replay' as const, result: retained.result }
				const claim = yield* normalizeEffect(() =>
					configuration.claim(invocation.identity, {
						state: 'pending',
						versions: invocation.versions,
						fingerprint,
					}),
				)
				return {
					kind: 'execute' as const,
					complete(
						result: ContractOutput<Replay>,
					): Effect.Effect<void, CompleteError, CompleteRequirements> {
						return normalizeEffect(() => configuration.final.encode(result)).pipe(
							Effect.flatMap((wire) =>
								normalizeEffect(() =>
									configuration.complete(claim, {
										state: 'completed',
										versions: invocation.versions,
										fingerprint,
										result: wire,
									}),
								),
							),
							Effect.asVoid,
						)
					},
				}
			})
		},
	}
}
function protocol<A>(evaluate: () => A): Effect.Effect<A, IdempotencyError> {
	return Effect.try({
		try: evaluate,
		catch: (error) => {
			// These pure protocol checks throw only IdempotencyError; unexpected failures remain defects.
			if (error instanceof IdempotencyError) return error
			throw error
		},
	})
}
