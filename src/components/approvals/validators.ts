import { zid, zodToConvex } from 'convex-helpers/server/zod4'
import { z } from 'zod'

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

export const approvalRunState = z.enum(APPROVAL_RUN_STATES)
export const approvalDecision = z.enum(APPROVAL_DECISIONS)
export const approvalStepKind = z.enum(APPROVAL_STEP_KINDS)
export const approvalCallbackKind = z.enum(APPROVAL_CALLBACK_KINDS)
export const approvalQuorumKind = z.enum(APPROVAL_QUORUM_KINDS)

export const approvalReference = z
	.string()
	.trim()
	.min(1)
	.max(MAX_APPROVAL_REFERENCE_LENGTH)

export const approvalName = z
	.string()
	.trim()
	.min(1)
	.max(MAX_APPROVAL_NAME_LENGTH)
	.regex(/^[A-Za-z][A-Za-z0-9._-]*$/)

export const approvalReason = z
	.string()
	.trim()
	.min(1)
	.max(MAX_APPROVAL_REASON_LENGTH)

export const approvalMetadata = z
	.record(
		z
			.string()
			.min(1)
			.max(MAX_APPROVAL_METADATA_KEY_LENGTH)
			.regex(/^(?![$_])[\x20-\x7E]+$/),
		z.string().max(MAX_APPROVAL_METADATA_VALUE_LENGTH),
	)
	.refine(
		(value) => Object.keys(value).length <= MAX_APPROVAL_METADATA_ENTRIES,
		`Metadata may contain at most ${MAX_APPROVAL_METADATA_ENTRIES} entries`,
	)

const approvalCallbackEvidence = z
	.object({
		stepKey: approvalName,
		actorRef: approvalReference,
		decision: approvalDecision,
		reason: approvalReason.optional(),
		decidedAt: z.number(),
	})
	.strict()

const approvalCallbackTerminalEvidence = approvalCallbackEvidence.omit({
	stepKey: true,
})

export const approvalCallbackInput = z
	.object({
		runId: approvalReference,
		scopeRef: approvalReference,
		resourceType: approvalName,
		resourceRef: approvalReference,
		metadata: approvalMetadata.optional(),
		decision: z
			.object({
				stepKey: approvalName,
				outcome: z.union([approvalDecision, z.literal('expired')]),
				evidence: z.array(approvalCallbackEvidence),
				terminalEvidence: approvalCallbackTerminalEvidence.optional(),
			})
			.strict()
			.optional(),
	})
	.strict()

/** Convex argument validator for approval mutation, action, and notify callbacks. */
export const approvalCallbackArgs = zodToConvex(approvalCallbackInput)

export const approvalActor = z
	.object({
		actorRef: approvalReference,
		capabilities: z.array(approvalName).max(MAX_APPROVAL_CAPABILITIES),
		metadata: approvalMetadata.optional(),
	})
	.strict()

export const approvalMutationCallback = z
	.object({
		kind: z.literal('mutation'),
		handle: approvalReference,
		retry: z.boolean(),
	})
	.strict()

export const approvalActionCallback = z
	.object({
		kind: z.literal('action'),
		handle: approvalReference,
		retry: z.boolean(),
	})
	.strict()

export const approvalCallback = z.discriminatedUnion('kind', [
	approvalMutationCallback,
	approvalActionCallback,
])

export const approvalQuorum = z
	.object({
		kind: approvalQuorumKind,
		approvals: z.number().int().positive().max(MAX_APPROVAL_DECISIONS_PER_STEP),
	})
	.strict()

export const approvalCallbackStep = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('mutation'),
			key: approvalName,
			callback: approvalMutationCallback,
		})
		.strict(),
	z
		.object({
			kind: z.literal('action'),
			key: approvalName,
			callback: approvalActionCallback,
		})
		.strict(),
])

export const approvalNotifyStep = z
	.object({
		kind: z.literal('notify'),
		key: approvalName,
		callback: approvalActionCallback,
	})
	.strict()

export const approvalDecisionStep = z
	.object({
		kind: z.literal('decision'),
		key: approvalName,
		decisions: z
			.array(approvalDecision)
			.min(1)
			.max(MAX_APPROVAL_DECISIONS_PER_STEP),
		quorum: approvalQuorum,
		makerChecker: z.boolean(),
		expiresAfterMs: z.number().int().positive().optional(),
	})
	.strict()

export const approvalBranchStep = z
	.object({
		kind: z.literal('branch'),
		key: approvalName,
		approvedStepKey: approvalName,
		rejectedStepKey: approvalName,
	})
	.strict()

export const approvalWorkflowStep = z.discriminatedUnion('kind', [
	approvalCallbackStep,
	approvalNotifyStep,
	approvalDecisionStep,
	approvalBranchStep,
])

export const approvalWorkflowDescriptor = z
	.object({
		schemaVersion: z.literal(APPROVAL_DESCRIPTOR_SCHEMA_VERSION),
		compatibilityKey: approvalName,
		name: approvalName,
		steps: z
			.array(approvalWorkflowStep)
			.min(1)
			.max(MAX_APPROVAL_WORKFLOW_STEPS),
	})
	.strict()
	.superRefine((descriptor, context) => {
		const keys = new Set<string>()
		const stepsByKey = new Map(
			descriptor.steps.map((step) => [step.key, step] as const),
		)
		const branchTargetOwners = new Map<string, number>()
		for (const [index, step] of descriptor.steps.entries()) {
			if (keys.has(step.key))
				context.addIssue({
					code: 'custom',
					message: `Duplicate workflow step key: ${step.key}`,
					path: ['steps', index, 'key'],
				})
			keys.add(step.key)
			if (
				step.kind === 'decision' &&
				new Set(step.decisions).size !== step.decisions.length
			)
				context.addIssue({
					code: 'custom',
					message: `Duplicate decision value in step: ${step.key}`,
					path: ['steps', index, 'decisions'],
				})
		}
		for (const [index, step] of descriptor.steps.entries()) {
			if (step.kind !== 'branch') continue
			if (descriptor.steps[index - 1]?.kind !== 'decision')
				context.addIssue({
					code: 'custom',
					message: `Branch must immediately follow a decision: ${step.key}`,
					path: ['steps', index],
				})
			for (const target of [step.approvedStepKey, step.rejectedStepKey]) {
				const targetStep = stepsByKey.get(target)
				const targetIndex = descriptor.steps.findIndex(
					(candidate) => candidate.key === target,
				)
				if (!targetStep)
					context.addIssue({
						code: 'custom',
						message: `Unknown branch target: ${target}`,
						path: ['steps', index],
					})
				else if (
					targetStep.kind !== 'mutation' &&
					targetStep.kind !== 'action' &&
					targetStep.kind !== 'notify'
				)
					context.addIssue({
						code: 'custom',
						message: `Branch target must be a callback step: ${target}`,
						path: ['steps', index],
					})
				else if (targetIndex <= index)
					context.addIssue({
						code: 'custom',
						message: `Branch target must be declared after its branch: ${target}`,
						path: ['steps', index],
					})
				branchTargetOwners.set(
					target,
					(branchTargetOwners.get(target) ?? 0) + 1,
				)
			}
		}
		for (const [target, owners] of branchTargetOwners) {
			if (owners !== 1)
				context.addIssue({
					code: 'custom',
					message: `Branch callback must belong to exactly one branch: ${target}`,
					path: ['steps'],
				})
		}
	})

export const approvalRunDocument = z
	.object({
		scopeRef: approvalReference,
		resourceType: approvalName,
		resourceRef: approvalReference,
		requester: approvalActor,
		metadata: approvalMetadata.optional(),
		workflow: approvalWorkflowDescriptor,
		state: approvalRunState,
		currentStepKey: approvalName.optional(),
		executionFailedStepKey: approvalName.optional(),
		expiresAt: z.number().optional(),
		workflowId: approvalReference.optional(),
		createdAt: z.number(),
		updatedAt: z.number(),
		terminalAt: z.number().optional(),
	})
	.strict()

export const approvalDecisionDocument = z
	.object({
		runId: zid('approvalRuns'),
		stepKey: approvalName,
		actor: approvalActor,
		decision: approvalDecision,
		reason: approvalReason.optional(),
		decidedAt: z.number(),
	})
	.strict()

export type ApprovalWorkflowDescriptor = z.infer<
	typeof approvalWorkflowDescriptor
>
export type ApprovalActor = z.infer<typeof approvalActor>
export type ApprovalMetadata = z.infer<typeof approvalMetadata>
export type ApprovalCallbackInput = Readonly<
	z.infer<typeof approvalCallbackInput>
>
