import { Cause, Context } from 'effect'
import type { DecodedFailure, ErrorContract, ErrorDefinitions } from '../contracts/errors'

/**
 * Inspect the whole Cause; cleanup defects and other composite reasons cannot become expected data.
 * A single defect projects only when the contract itself recognizes it, such as a declared error
 * that a handler threw instead of failing with; any other defect stays an UnknownFailure.
 */
export function projectErrorCause<Definitions extends ErrorDefinitions>(
	contract: Pick<ErrorContract<Definitions>, 'project'>,
	cause: Cause.Cause<unknown>,
): DecodedFailure<Definitions> {
	if (cause.reasons.length !== 1) return { _tag: 'UnknownFailure', version: 1 }
	const reason = cause.reasons[0]
	if (Cause.isFailReason(reason)) return contract.project(reason.error)
	if (Cause.isDieReason(reason)) return contract.project(reason.defect)
	return { _tag: 'UnknownFailure', version: 1 }
}

// Keep the exact throwable as the defect. The private annotation authorizes the API adapter
// to throw it and gives the audit sink an identity even when a hook returns a primitive.
type ArgumentRejection = Readonly<{ declared: boolean }>
const ArgumentRejection = Context.Reference<ArgumentRejection | undefined>(
	'cvx-kit/effect/ArgumentRejection',
	{ defaultValue: () => undefined },
)

const argumentRejections = new WeakSet<ArgumentRejection>()

export function markArgumentRejection(cause: Cause.Cause<never>, declared: boolean) {
	const rejection = { declared }
	argumentRejections.add(rejection)
	return Cause.annotate(cause, Context.make(ArgumentRejection, rejection))
}

export function getArgumentRejection(cause: Cause.Cause<unknown>) {
	if (cause.reasons.length !== 1 || !Cause.isDieReason(cause.reasons[0])) return undefined
	const rejection = Context.get(Cause.reasonAnnotations(cause.reasons[0]), ArgumentRejection)
	return rejection && argumentRejections.has(rejection) ? rejection : undefined
}
