import type { ApprovalRunState } from './constants'

export function canTransitionApprovalRun(
	from: ApprovalRunState,
	to: ApprovalRunState,
): boolean {
	return (
		LEGAL_APPROVAL_RUN_TRANSITIONS[from] as readonly ApprovalRunState[]
	).includes(to)
}

export function classifyPendingRunAt(
	now: number,
	expiresAt: number,
): 'pending' | 'expired' {
	return now >= expiresAt ? 'expired' : 'pending'
}

const LEGAL_APPROVAL_RUN_TRANSITIONS = {
	pending: ['approved', 'rejected', 'expired', 'canceled'],
	approved: [],
	rejected: [],
	expired: [],
	canceled: [],
} as const satisfies Readonly<
	Record<ApprovalRunState, readonly ApprovalRunState[]>
>
