/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Transport errors are untrusted; callback results are inferred independently. */
import type { UnknownFailure, FailureContract, FailureOf } from '../modules/contracts/errors'
import { decodeFailure } from '../modules/contracts/errors'
// oxlint-disable-next-line cvx/no-internal-reexports -- Preserve existing helper imports while sharing transport decoding with neutral contract composition.
export { decodeFailure, type FailureContract, type FailureOf } from '../modules/contracts/errors'

type DeclaredOf<Contract extends FailureContract> = Extract<
	FailureOf<Contract>,
	{ _tag: 'DeclaredFailure' }
>

/** Return a selected validated failure; never mutate or narrow the caught error itself. */
export function failureOf<
	Contract extends FailureContract,
	const Codes extends readonly DeclaredOf<Contract>['code'][],
>(
	error: unknown,
	contract: Contract,
	...codes: Codes
): Extract<DeclaredOf<Contract>, { code: Codes[number] }> | undefined {
	const failure = decodeFailure(error, contract)
	if (failure._tag !== 'DeclaredFailure' || !codes.includes(failure.code)) return undefined
	// SAFETY: only a decoded declared failure whose code occurs in the requested set is returned.
	return failure as Extract<DeclaredOf<Contract>, { code: Codes[number] }>
}

/** Boolean convenience predicate; use failureOf to access narrowed details. */
export function isFailure<
	Contract extends FailureContract,
	const Codes extends readonly DeclaredOf<Contract>['code'][],
>(error: unknown, contract: Contract, ...codes: Codes): boolean {
	return failureOf(error, contract, ...codes) !== undefined
}

type DeclaredHandlers<Contract extends FailureContract> = {
	[Code in DeclaredOf<Contract>['code']]: (
		failure: Code extends '_' ? FailureOf<Contract> : Extract<DeclaredOf<Contract>, { code: Code }>,
	) => unknown
}
export type FailureHandlers<Contract extends FailureContract> =
	| DeclaredHandlers<Contract>
	| (Partial<DeclaredHandlers<Contract>> & { _: (failure: FailureOf<Contract>) => unknown })
type HandlerResult<Handlers> = {
	[Key in keyof Handlers]: Handlers[Key] extends (...args: never[]) => infer Result ? Result : never
}[keyof Handlers]

/** Dispatch on code after validation. Without `_`, unknown errors return UnknownFailure. */
export function matchFailure<Contract extends FailureContract, const Handlers extends object>(
	error: unknown,
	contract: Contract,
	handlers: Partial<DeclaredHandlers<NoInfer<Contract>>> & {
		_: (failure: FailureOf<NoInfer<Contract>>) => unknown
	} & Handlers &
		Record<Exclude<keyof Handlers, keyof DeclaredHandlers<Contract> | '_'>, never>,
): HandlerResult<Handlers>
export function matchFailure<Contract extends FailureContract, const Handlers extends object>(
	error: unknown,
	contract: Contract,
	handlers: DeclaredHandlers<NoInfer<Contract>> &
		Handlers &
		Record<Exclude<keyof Handlers, keyof DeclaredHandlers<Contract>>, never>,
): HandlerResult<Handlers> | UnknownFailure
export function matchFailure<Contract extends FailureContract>(
	error: unknown,
	contract: Contract,
	handlers: FailureHandlers<Contract>,
): unknown {
	const failure = decodeFailure(error, contract)
	// SAFETY: the checked declaration pairs each callback with its code; only the validated code selects it.
	const callbacks = handlers as Record<
		string,
		((failure: FailureOf<Contract>) => unknown) | undefined
	>
	const handler =
		failure._tag === 'DeclaredFailure' && Object.hasOwn(handlers, failure.code)
			? callbacks[failure.code]
			: undefined
	return handler
		? handler(failure)
		: Object.hasOwn(handlers, '_') && callbacks._
			? callbacks._(failure)
			: failure
}
