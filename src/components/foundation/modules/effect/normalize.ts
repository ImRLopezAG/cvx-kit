import { Cause, Effect } from 'effect'
import type { CallbackError, CallbackRequirements, EffectValue } from './operation'

/** Invoke ordinary and Effect callbacks lazily, preserving ordinary failures as defects. */
export function normalizeEffect<Returned>(
	invoke: () => Returned,
): Effect.Effect<EffectValue<Returned>, CallbackError<Returned>, CallbackRequirements<Returned>> {
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Internal callback normalization boundary; the selected schema validates the eventual value.
	function resolve(value: unknown): Effect.Effect<unknown, unknown, unknown> {
		if (Effect.isEffect(value)) return Effect.flatMap(value, resolve)
		return Effect.promise(() => Promise.resolve(value)).pipe(
			Effect.flatMap((resolved) =>
				Effect.isEffect(resolved) ? resolve(resolved) : Effect.succeed(resolved),
			),
		)
	}
	const normalized = Effect.suspend(() => resolve(invoke()))
	// SAFETY: the predicate retains Effect channels; ordinary values and rejections
	// contribute no typed errors/services. The invocation's concrete return owns A/E/R.
	return normalized as Effect.Effect<
		EffectValue<Returned>,
		CallbackError<Returned>,
		CallbackRequirements<Returned>
	>
}

/** Classify singular failures by their value; retain structured interruption/composite causes. */
export function observationFailure<Error>(cause: Cause.Cause<Error>) {
	const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined
	if (reason && Cause.isFailReason(reason)) return reason.error
	if (reason && Cause.isDieReason(reason)) return reason.defect
	return cause
}
