import { Cause } from 'effect'
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
