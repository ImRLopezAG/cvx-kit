import {
	createFunctionHandle,
	type FunctionReference,
	type FunctionType,
	type FunctionHandle,
} from 'convex/server'

import type { ApprovalDecision } from './constants'
import {
	approvalWorkflowDescriptor,
	type ApprovalCallbackInput,
	type ApprovalWorkflowDescriptor,
} from './validators'

export type ApprovalMutationStep = Readonly<{
	kind: 'mutation'
	key: string
	handler: FunctionReference<'mutation', 'internal'>
	retry: boolean
}>

export type ApprovalActionStep = Readonly<{
	kind: 'action'
	key: string
	handler: FunctionReference<'action', 'internal'>
	retry: boolean
}>

export type ApprovalNotifyStep = Readonly<{
	kind: 'notify'
	key: string
	handler: FunctionReference<'action', 'internal'>
	retry: boolean
}>

export type ApprovalDecisionStep = Readonly<{
	kind: 'decision'
	key: string
	decisions: readonly ApprovalDecision[]
	quorum: Readonly<{ kind: 'count'; approvals: number }>
	makerChecker: boolean
	expiresAfterMs?: number
}>

export type ApprovalBranchStep = Readonly<{
	kind: 'branch'
	key: string
	approvedStepKey: string
	rejectedStepKey: string
}>

export type ApprovalWorkflowStep =
	| ApprovalMutationStep
	| ApprovalActionStep
	| ApprovalNotifyStep
	| ApprovalDecisionStep
	| ApprovalBranchStep

export type ApprovalDefinition = Readonly<{
	name: string
	compatibilityKey: string
	steps: readonly ApprovalWorkflowStep[]
}>

export type CreateApprovalHandle = (
	reference: FunctionReference<'mutation' | 'action', 'internal'>,
) => Promise<string>

export type ApprovalDecisionEvidence = Readonly<{
	actorRef: string
	decision: ApprovalDecision
}>

export function approvalDecisionEventName(runId: string, stepKey: string): string {
	return `approval:${runId}:${stepKey}`
}

export function evaluateDecisionOutcome(
	decisions: readonly ApprovalDecisionEvidence[],
	approvalsRequired: number,
): ApprovalDecision | null {
	if (decisions.some((decision) => decision.decision === 'rejected')) return 'rejected'
	return decisions.filter((decision) => decision.decision === 'approved').length >=
		approvalsRequired
		? 'approved'
		: null
}

export function resolveWorkflowStepIndex(stepKeys: readonly string[], targetKey: string): number {
	const index = stepKeys.indexOf(targetKey)
	if (index === -1) throw new Error(`Unknown approval workflow step: ${targetKey}`)
	return index
}

export function callbackReference<Type extends FunctionType>(
	handle: string,
): FunctionReference<Type, 'internal', ApprovalCallbackInput, unknown> {
	// SAFETY: descriptors persist handles produced by createFunctionHandle; Convex resolves them on invocation.
	return handle as FunctionHandle<Type, ApprovalCallbackInput, unknown>
}

export async function compileApprovalDescriptor(
	definition: ApprovalDefinition,
	createHandle: CreateApprovalHandle = createFunctionHandle,
): Promise<Readonly<ApprovalWorkflowDescriptor>> {
	const steps = await Promise.all(
		definition.steps.map(async (step) => {
			if (step.kind === 'mutation' || step.kind === 'action') {
				return {
					kind: step.kind,
					key: step.key,
					callback: {
						kind: step.kind,
						handle: await createHandle(step.handler),
						retry: step.retry,
					},
				}
			}
			if (step.kind === 'notify') {
				return {
					kind: step.kind,
					key: step.key,
					callback: {
						kind: 'action' as const,
						handle: await createHandle(step.handler),
						retry: step.retry,
					},
				}
			}
			if (step.kind === 'decision') {
				return {
					...step,
					decisions: [...step.decisions],
					quorum: { ...step.quorum },
				}
			}
			return { ...step }
		}),
	)
	const descriptor = approvalWorkflowDescriptor.parse({
		schemaVersion: 1,
		compatibilityKey: definition.compatibilityKey,
		name: definition.name,
		steps,
	})
	return deepFreeze(descriptor)
}

function deepFreeze(descriptor: ApprovalWorkflowDescriptor): Readonly<ApprovalWorkflowDescriptor> {
	for (const step of descriptor.steps) {
		if (step.kind === 'decision') {
			Object.freeze(step.decisions)
			Object.freeze(step.quorum)
		} else if ('callback' in step) {
			Object.freeze(step.callback)
		}
		Object.freeze(step)
	}
	Object.freeze(descriptor.steps)
	return Object.freeze(descriptor)
}
