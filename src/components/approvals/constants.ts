export const APPROVAL_RUN_STATES = [
	'pending',
	'approved',
	'rejected',
	'expired',
	'canceled',
] as const

export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const

export const APPROVAL_EXECUTION_STATES = [
	'inProgress',
	'completed',
	'canceled',
	'failed',
] as const

export const APPROVAL_STEP_KINDS = [
	'mutation',
	'action',
	'notify',
	'decision',
	'branch',
] as const

export const APPROVAL_QUORUM_KINDS = ['count'] as const

export const APPROVAL_CALLBACK_KINDS = ['mutation', 'action'] as const

export const APPROVAL_DESCRIPTOR_SCHEMA_VERSION = 1 as const

/** Version of the component-owned tables and indexes deployed by cvx-kit. */
export const APPROVAL_COMPONENT_SCHEMA_VERSION = 1 as const

/** Indexes required by approval evidence reads and decision writes. */
export const APPROVAL_DECISION_HISTORY_INDEX =
	'by_runId_and_decidedAt' as const
export const APPROVAL_ACTOR_DECISION_INDEX =
	'by_runId_and_stepKey_and_actor_actorRef' as const
export const APPROVAL_REQUIRED_DECISION_INDEXES = [
	APPROVAL_DECISION_HISTORY_INDEX,
	APPROVAL_ACTOR_DECISION_INDEX,
] as const

export const APPROVAL_AUDIT_RETENTION_CATEGORY = 'approval-protocol'
export const MIN_APPROVAL_AUDIT_RETENTION_DAYS = 1
export const MAX_APPROVAL_AUDIT_RETENTION_DAYS = 3_650
export const MAX_APPROVAL_AUDIT_CLEANUP_BATCH_SIZE = 100

export const MAX_APPROVAL_REFERENCE_LENGTH = 256
export const MAX_APPROVAL_NAME_LENGTH = 96
export const MAX_APPROVAL_REASON_LENGTH = 500
export const MAX_APPROVAL_CAPABILITIES = 32
export const MAX_APPROVAL_METADATA_ENTRIES = 32
export const MAX_APPROVAL_METADATA_KEY_LENGTH = 64
export const MAX_APPROVAL_METADATA_VALUE_LENGTH = 512
export const MAX_APPROVAL_WORKFLOW_STEPS = 32
export const MAX_APPROVAL_DECISIONS_PER_STEP = 8

export type ApprovalRunState = (typeof APPROVAL_RUN_STATES)[number]
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]
export type ApprovalExecutionState = (typeof APPROVAL_EXECUTION_STATES)[number]
export type ApprovalStepKind = (typeof APPROVAL_STEP_KINDS)[number]
export type ApprovalCallbackKind = (typeof APPROVAL_CALLBACK_KINDS)[number]
