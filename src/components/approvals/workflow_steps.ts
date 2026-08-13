import {
	createFunctionHandle,
	type FunctionReference,
	type FunctionType,
} from 'convex/server'

import type { ApprovalDecision } from './constants'
import {
	approvalWorkflowDescriptor,
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

export type ApprovalCallbackInput = Readonly<{
	runId: string
	scopeRef: string
	resourceType: string
	resourceRef: string
	metadata?: Readonly<Record<string, string>>
	decision?: Readonly<{
		stepKey: string
		outcome: ApprovalDecision | 'expired'
		evidence: readonly Readonly<{
			actorRef: string
			decision: ApprovalDecision
			reason?: string
			decidedAt: number
		}>[]
		terminalEvidence?: Readonly<{
			actorRef: string
			decision: ApprovalDecision
			reason?: string
			decidedAt: number
		}>
	}>
}>

export function approvalDecisionEventName(
	runId: string,
	stepKey: string,
): string {
	return `approval:${runId}:${stepKey}`
}

export function evaluateDecisionOutcome(
	decisions: readonly ApprovalDecisionEvidence[],
	approvalsRequired: number,
): ApprovalDecision | null {
	if (decisions.some((decision) => decision.decision === 'rejected'))
		return 'rejected'
	return decisions.filter((decision) => decision.decision === 'approved')
		.length >= approvalsRequired
		? 'approved'
		: null
}

export function resolveWorkflowStepIndex(
	stepKeys: readonly string[],
	targetKey: string,
): number {
	const index = stepKeys.indexOf(targetKey)
	if (index === -1)
		throw new Error(`Unknown approval workflow step: ${targetKey}`)
	return index
}

export function callbackReference<Type extends FunctionType>(
	handle: string,
): FunctionReference<Type, 'internal', ApprovalCallbackInput, unknown> {
	return handle as unknown as FunctionReference<
		Type,
		'internal',
		ApprovalCallbackInput,
		unknown
	>
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

function deepFreeze<Value>(value: Value): Readonly<Value> {
	if (value && typeof value === 'object') {
		Object.freeze(value)
		for (const nested of Object.values(value)) deepFreeze(nested)
	}
	return value
}
