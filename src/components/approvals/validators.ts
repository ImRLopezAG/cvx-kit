// oxlint-disable-next-line cvx/component-boundaries -- Kit-shipped component: `k` ships in this package and the relative import stays inside dist/; host-authored components keep the rule.
import { k } from '../../k'

import {
	APPROVAL_CALLBACK_KINDS,
	APPROVAL_DECISIONS,
	APPROVAL_DESCRIPTOR_SCHEMA_VERSION,
	APPROVAL_QUORUM_KINDS,
	APPROVAL_RUN_STATES,
	APPROVAL_STEP_KINDS,
	MAX_APPROVAL_CAPABILITIES,
	MAX_APPROVAL_DECISIONS_PER_STEP,
	MAX_APPROVAL_METADATA_ENTRIES,
	MAX_APPROVAL_METADATA_KEY_LENGTH,
	MAX_APPROVAL_METADATA_VALUE_LENGTH,
	MAX_APPROVAL_NAME_LENGTH,
	MAX_APPROVAL_REASON_LENGTH,
	MAX_APPROVAL_REFERENCE_LENGTH,
	MAX_APPROVAL_WORKFLOW_STEPS,
} from './constants'

/** v1's `z.number()` rejected `NaN` and infinities on parse; natively this stays `v.number()`. */
const approvalNumber = k.number().refine(Number.isFinite, 'Expected a finite number')

export const approvalRunState = k.enum(APPROVAL_RUN_STATES)
export const approvalDecision = k.enum(APPROVAL_DECISIONS)
export const approvalStepKind = k.enum(APPROVAL_STEP_KINDS)
export const approvalCallbackKind = k.enum(APPROVAL_CALLBACK_KINDS)
export const approvalQuorumKind = k.enum(APPROVAL_QUORUM_KINDS)

export const approvalReference = k.string().trim().min(1).max(MAX_APPROVAL_REFERENCE_LENGTH)

export const approvalName = k
	.string()
	.trim()
	.min(1)
	.max(MAX_APPROVAL_NAME_LENGTH)
	.regex(/^[A-Za-z][A-Za-z0-9._-]*$/)

export const approvalReason = k.string().trim().min(1).max(MAX_APPROVAL_REASON_LENGTH)

export const approvalMetadata = k
	.record(
		k
			.string()
			.min(1)
			.max(MAX_APPROVAL_METADATA_KEY_LENGTH)
			.regex(/^(?![$_])[\x20-\x7E]+$/),
		k.string().max(MAX_APPROVAL_METADATA_VALUE_LENGTH),
	)
	.refine(
		(value) => Object.keys(value).length <= MAX_APPROVAL_METADATA_ENTRIES,
		`Metadata may contain at most ${MAX_APPROVAL_METADATA_ENTRIES} entries`,
	)

const approvalCallbackEvidence = k.object({
	stepKey: approvalName,
	actorRef: approvalReference,
	decision: approvalDecision,
	reason: approvalReason.optional(),
	decidedAt: approvalNumber,
})

const approvalCallbackTerminalEvidence = approvalCallbackEvidence.omit('stepKey')

export const approvalCallbackInput = k.object({
	runId: approvalReference,
	scopeRef: approvalReference,
	resourceType: approvalName,
	resourceRef: approvalReference,
	metadata: approvalMetadata.optional(),
	decision: k
		.object({
			stepKey: approvalName,
			outcome: k.union([approvalDecision, k.literal('expired')]),
			evidence: k.array(approvalCallbackEvidence),
			terminalEvidence: approvalCallbackTerminalEvidence.optional(),
		})
		.optional(),
})

/** Convex argument validator for approval mutation, action, and notify callbacks. */
export const approvalCallbackArgs = approvalCallbackInput.validator

export const approvalActor = k.object({
	actorRef: approvalReference,
	capabilities: k.array(approvalName).max(MAX_APPROVAL_CAPABILITIES),
	metadata: approvalMetadata.optional(),
})

export const approvalMutationCallback = k.object({
	kind: k.literal('mutation'),
	handle: approvalReference,
	retry: k.boolean(),
})

export const approvalActionCallback = k.object({
	kind: k.literal('action'),
	handle: approvalReference,
	retry: k.boolean(),
})

export const approvalCallback = k.discriminatedUnion('kind', [
	approvalMutationCallback,
	approvalActionCallback,
])

export const approvalQuorum = k.object({
	kind: approvalQuorumKind,
	approvals: k.int().min(1).max(MAX_APPROVAL_DECISIONS_PER_STEP),
})

export const approvalCallbackStep = k.discriminatedUnion('kind', [
	k.object({
		kind: k.literal('mutation'),
		key: approvalName,
		callback: approvalMutationCallback,
	}),
	k.object({
		kind: k.literal('action'),
		key: approvalName,
		callback: approvalActionCallback,
	}),
])

export const approvalNotifyStep = k.object({
	kind: k.literal('notify'),
	key: approvalName,
	callback: approvalActionCallback,
})

export const approvalDecisionStep = k.object({
	kind: k.literal('decision'),
	key: approvalName,
	decisions: k.array(approvalDecision).min(1).max(MAX_APPROVAL_DECISIONS_PER_STEP),
	quorum: approvalQuorum,
	makerChecker: k.boolean(),
	// v1's `.int()` accepted safe integers only.
	expiresAfterMs: k.int().min(1).refine(Number.isSafeInteger, 'Expected a safe integer').optional(),
})

export const approvalBranchStep = k.object({
	kind: k.literal('branch'),
	key: approvalName,
	approvedStepKey: approvalName,
	rejectedStepKey: approvalName,
})

/**
 * A plain union, not a discriminated one: its first member is itself a union over `kind`, which a
 * discriminated union cannot dispatch to. Natively both are the same `v.union`.
 */
export const approvalWorkflowStep = k.union([
	approvalCallbackStep,
	approvalNotifyStep,
	approvalDecisionStep,
	approvalBranchStep,
])

export const approvalWorkflowDescriptor = k
	.object({
		schemaVersion: k.literal(APPROVAL_DESCRIPTOR_SCHEMA_VERSION),
		compatibilityKey: approvalName,
		name: approvalName,
		steps: k.array(approvalWorkflowStep).min(1).max(MAX_APPROVAL_WORKFLOW_STEPS),
	})
	.check((descriptor, context) => {
		const keys = new Set<string>()
		const stepsByKey = new Map(descriptor.steps.map((step) => [step.key, step] as const))
		const branchTargetOwners = new Map<string, number>()
		for (const [index, step] of descriptor.steps.entries()) {
			if (keys.has(step.key))
				context.addIssue({
					message: `Duplicate workflow step key: ${step.key}`,
					path: ['steps', index, 'key'],
				})
			keys.add(step.key)
			if (step.kind === 'decision' && new Set(step.decisions).size !== step.decisions.length)
				context.addIssue({
					message: `Duplicate decision value in step: ${step.key}`,
					path: ['steps', index, 'decisions'],
				})
		}
		for (const [index, step] of descriptor.steps.entries()) {
			if (step.kind !== 'branch') continue
			if (descriptor.steps[index - 1]?.kind !== 'decision')
				context.addIssue({
					message: `Branch must immediately follow a decision: ${step.key}`,
					path: ['steps', index],
				})
			for (const target of [step.approvedStepKey, step.rejectedStepKey]) {
				const targetStep = stepsByKey.get(target)
				const targetIndex = descriptor.steps.findIndex((candidate) => candidate.key === target)
				if (!targetStep)
					context.addIssue({
						message: `Unknown branch target: ${target}`,
						path: ['steps', index],
					})
				else if (
					targetStep.kind !== 'mutation' &&
					targetStep.kind !== 'action' &&
					targetStep.kind !== 'notify'
				)
					context.addIssue({
						message: `Branch target must be a callback step: ${target}`,
						path: ['steps', index],
					})
				else if (targetIndex <= index)
					context.addIssue({
						message: `Branch target must be declared after its branch: ${target}`,
						path: ['steps', index],
					})
				branchTargetOwners.set(target, (branchTargetOwners.get(target) ?? 0) + 1)
			}
		}
		for (const [target, owners] of branchTargetOwners) {
			if (owners !== 1)
				context.addIssue({
					message: `Branch callback must belong to exactly one branch: ${target}`,
					path: ['steps'],
				})
		}
	})

export const approvalRunDocument = k.object({
	scopeRef: approvalReference,
	resourceType: approvalName,
	resourceRef: approvalReference,
	requester: approvalActor,
	metadata: approvalMetadata.optional(),
	workflow: approvalWorkflowDescriptor,
	state: approvalRunState,
	currentStepKey: approvalName.optional(),
	executionFailedStepKey: approvalName.optional(),
	expiresAt: approvalNumber.optional(),
	workflowId: approvalReference.optional(),
	createdAt: approvalNumber,
	updatedAt: approvalNumber,
	terminalAt: approvalNumber.optional(),
})

export const approvalDecisionDocument = k.object({
	runId: k.id('approvalRuns'),
	stepKey: approvalName,
	actor: approvalActor,
	decision: approvalDecision,
	reason: approvalReason.optional(),
	decidedAt: approvalNumber,
})

/**
 * The fields `approvals.audit.history` reads from an audit-log event. Unknown keys are stripped, as
 * v1's non-strict Zod objects did, and a non-string `actorId` is dropped by the caller.
 */
export const approvalAuditEventProjection = k
	.object({
		action: k.string(),
		actorId: k.any().optional(),
		metadata: k.object({ correlationKey: k.string(), transition: k.string() }).strip(),
	})
	.strip()

export const approvalOptionalString = k.string().optional()

export type ApprovalWorkflowDescriptor = k.infer<typeof approvalWorkflowDescriptor>
export type ApprovalActor = k.infer<typeof approvalActor>
export type ApprovalMetadata = k.infer<typeof approvalMetadata>
export type ApprovalCallbackInput = Readonly<k.infer<typeof approvalCallbackInput>>
