import { defaultErrors, type ErrorFactory } from './errors'

/**
 * Typed transition legality from a constants tuple (the conventions.md
 * vocabulary pattern). The transition map is typed against the tuple, so an
 * invalid literal cannot compile; `assert` throws via the injected
 * ErrorFactory so it drops straight into a command guard.
 */
export function createStateMachine<const State extends string>(
	states: readonly State[],
	// NoInfer: the vocabulary comes from the tuple; a stray literal in the
	// transition map must fail to compile, not widen the state union.
	transitions: Partial<Record<NoInfer<State>, readonly NoInfer<State>[]>>,
	options?: { errors?: ErrorFactory },
) {
	const errors = options?.errors ?? defaultErrors
	const legal = new Map<State, ReadonlySet<State>>(
		states.map((state) => [state, new Set(transitions[state] ?? [])]),
	)

	function can(from: State, to: State): boolean {
		return legal.get(from)?.has(to) ?? false
	}

	function assert(from: State, to: State): void {
		if (!can(from, to)) {
			errors.throw({
				code: 'INVALID_TRANSITION',
				message: `Transition "${from}" → "${to}" is not legal`,
			})
		}
	}

	return Object.freeze({ states, can, assert })
}
