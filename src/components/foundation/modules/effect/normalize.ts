import { Effect } from 'effect'
import type { CallbackError, CallbackRequirements, EffectValue } from './operation'

/** Invoke ordinary and Effect callbacks lazily, preserving ordinary failures as defects. */
export function normalizeEffect<Returned>(
	invoke: () => Returned,
): Effect.Effect<EffectValue<Returned>, CallbackError<Returned>, CallbackRequirements<Returned>> {
	const normalized = Effect.suspend(() => {
		const value = invoke()
		if (Effect.isEffect(value)) return value
		return Effect.promise(() => Promise.resolve(value))
	})
	// SAFETY: the predicate retains Effect channels; ordinary values and rejections
	// contribute no typed errors/services. The invocation's concrete return owns A/E/R.
	return normalized as Effect.Effect<
		EffectValue<Returned>,
		CallbackError<Returned>,
		CallbackRequirements<Returned>
	>
}
