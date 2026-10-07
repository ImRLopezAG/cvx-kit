import { Cause } from 'effect'
import type { DecodedFailure, ErrorContract, ErrorDefinitions } from '../contracts/errors'

/** Inspect the whole Cause; cleanup defects and other composite reasons cannot become expected data. */
export function projectErrorCause<Definitions extends ErrorDefinitions>(
	contract: Pick<ErrorContract<Definitions>, 'project'>,
	cause: Cause.Cause<unknown>,
): DecodedFailure<Definitions> {
	if (cause.reasons.length !== 1) return { _tag: 'UnknownFailure', version: 1 }
	const reason = cause.reasons[0]
	return Cause.isFailReason(reason)
		? contract.project(reason.error)
		: { _tag: 'UnknownFailure', version: 1 }
}
