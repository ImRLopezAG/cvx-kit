import { Effect } from 'effect'
import {
	decodeFailure,
	type DeclaredError,
	type DeclaredErrorDetails,
	type ErrorContract,
	type ErrorDefinitions,
} from '../contracts/errors'

type Code<Definitions extends ErrorDefinitions> = Extract<keyof Definitions, string>
/** Details are optional exactly when the code declares no detail fields. */
type DetailArguments<Definitions extends ErrorDefinitions, Key extends Code<Definitions>> = [
	keyof Definitions[Key]['details'],
] extends [never]
	? [details?: DeclaredErrorDetails<Definitions, Key>]
	: [details: DeclaredErrorDetails<Definitions, Key>]

/** Effect helpers bound to one declared error contract. */
export type EffectErrors<Definitions extends ErrorDefinitions> = Readonly<{
	/** A yieldable failure with the contract's typed declared error: `return yield* fail('NOT_FOUND')`. */
	fail: <Key extends Code<Definitions>>(
		code: Key,
		...details: DetailArguments<Definitions, NoInfer<Key>>
	) => Effect.Effect<never, Extract<DeclaredError<Definitions>, { code: Key }>>
	/**
	 * Run sync or async work; a thrown declared error of this contract, or a ConvexError carrying
	 * one of its declared envelopes, lands in the typed failure channel. Any other throw is a defect.
	 */
	attempt: <Value>(
		run: () => Value | PromiseLike<Value>,
	) => Effect.Effect<Value, DeclaredError<Definitions>>
}>

/** Bind `fail` and `attempt` to a declared error contract. */
export function effectErrors<const Definitions extends ErrorDefinitions>(
	contract: Pick<ErrorContract<Definitions>, 'create' | 'project' | 'decode'>,
): EffectErrors<Definitions> {
	return Object.freeze({
		fail: (code, ...details) =>
			Effect.suspend(() =>
				// SAFETY: omitted details are allowed only for codes that declare no detail fields; `create` validates them.
				Effect.fail(contract.create(code, (details[0] ?? {}) as never)),
			),
		attempt: (run) =>
			Effect.tryPromise({ try: async () => run(), catch: (thrown) => thrown }).pipe(
				Effect.catch((thrown) => {
					if (contract.project(thrown)._tag === 'DeclaredFailure')
						// SAFETY: `project` recognizes only declared errors this contract created.
						return Effect.fail(thrown as DeclaredError<Definitions>)
					const decoded = decodeFailure(thrown, contract)
					if (decoded._tag === 'DeclaredFailure')
						// SAFETY: `decode` validated these details against this code's declaration.
						return Effect.fail(contract.create(decoded.code, decoded.details as never))
					return Effect.die(thrown)
				}),
			),
	} satisfies EffectErrors<Definitions>)
}
