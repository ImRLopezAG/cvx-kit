/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Transport errors are untrusted; callback results are inferred independently. */
import { ConvexError } from 'convex/values'
import type { ErrorContract, ErrorDefinitions, UnknownFailure } from '../modules/contracts/errors'

export type FailureContract = Pick<ErrorContract<ErrorDefinitions>, 'decode'>
export type FailureOf<Contract extends FailureContract> = ReturnType<Contract['decode']>
type DeclaredOf<Contract extends FailureContract> = Extract<
	FailureOf<Contract>,
	{ _tag: 'DeclaredFailure' }
>

/** Extract ConvexError.data only. Contract validation owns the public envelope. */
export function decodeFailure<Contract extends FailureContract>(
	error: unknown,
	contract: Contract,
): FailureOf<Contract> {
	let failure: ReturnType<FailureContract['decode']> = { _tag: 'UnknownFailure', version: 1 }
	try {
		if (error instanceof ConvexError) failure = contract.decode(error.data)
	} catch {
		// Malformed proxies/getters and foreign errors never expose their diagnostics.
	}
	// SAFETY: the explicit contract owns its decode result; every error contract includes UnknownFailure.
	return failure as FailureOf<Contract>
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
