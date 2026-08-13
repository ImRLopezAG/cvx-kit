import { WorkflowManager, type WorkflowCtx } from '@convex-dev/workflow'
import { v } from 'convex/values'

import { components, internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { APPROVAL_DECISIONS, APPROVAL_RUN_STATES } from './constants'
import {
	approvalDecisionEventName,
	callbackReference,
	resolveWorkflowStepIndex,
	type ApprovalCallbackInput,
} from './workflow_steps'

export const approvalWorkflow = new WorkflowManager(components.workflow)

export const run = approvalWorkflow.define({
	args: { runId: v.id('approvalRuns') },
	returns: v.null(),
	handler: async (step, input) => {
		let failedStepKey: string | undefined
		try {
			const run: Doc<'approvalRuns'> | null = await step.runQuery(
				internal.requests.getForWorkflow,
				{ runId: input.runId },
				{ name: 'loadLinkedApproval' },
			)
			if (!run) throw new Error('Approval request not found')
			if (run.workflowId !== step.workflowId)
				throw new Error('Approval workflow linkage is incomplete')

			const callbackInput = buildCallbackInput(run)
			const stepKeys = run.workflow.steps.map(
				(workflowStep) => workflowStep.key,
			)
			const branchTargets = new Set(
				run.workflow.steps.flatMap((workflowStep) =>
					workflowStep.kind === 'branch'
						? [workflowStep.approvedStepKey, workflowStep.rejectedStepKey]
						: [],
				),
			)
			let lastDecision: 'approved' | 'rejected' | 'expired' | null = null
			let lastDecisionStepKey: string | null = null
			let terminalEvidence:
				| {
						actorRef: string
						decision: 'approved' | 'rejected'
						reason?: string
						decidedAt: number
				  }
				| undefined
			let index = 0
			while (index < run.workflow.steps.length) {
				const workflowStep = run.workflow.steps[index]
				if (
					workflowStep.kind === 'mutation' ||
					workflowStep.kind === 'action' ||
					workflowStep.kind === 'notify'
				) {
					if (branchTargets.has(workflowStep.key)) {
						index += 1
						continue
					}
					failedStepKey = workflowStep.key
					await executeCallback(step, workflowStep, callbackInput)
					failedStepKey = undefined
					index += 1
					continue
				}
				if (workflowStep.kind === 'decision') {
					await step.runMutation(
						internal.decisions.enter,
						{
							runId: run._id,
							stepKey: workflowStep.key,
							workflowId: step.workflowId,
							...(workflowStep.expiresAfterMs === undefined
								? {}
								: { expiresAfterMs: workflowStep.expiresAfterMs }),
						},
						{ name: `enter:${workflowStep.key}` },
					)
					const event = await step.awaitEvent({
						name: approvalDecisionEventName(run._id, workflowStep.key),
						validator: v.object({
							outcome: v.union(
								v.literal(APPROVAL_DECISIONS[0]),
								v.literal(APPROVAL_DECISIONS[1]),
								v.literal(APPROVAL_RUN_STATES[3]),
							),
							terminalEvidence: v.optional(
								v.object({
									actorRef: v.string(),
									decision: v.union(
										v.literal(APPROVAL_DECISIONS[0]),
										v.literal(APPROVAL_DECISIONS[1]),
									),
									reason: v.optional(v.string()),
									decidedAt: v.number(),
								}),
							),
						}),
					})
					lastDecision = event.outcome
					terminalEvidence = event.terminalEvidence
					lastDecisionStepKey = workflowStep.key
					if (
						lastDecision !== 'approved' &&
						run.workflow.steps[index + 1]?.kind !== 'branch'
					)
						break
					index += 1
					continue
				}
				if (!lastDecision)
					throw new Error('Branch requires a preceding decision step')
				const targetKey =
					lastDecision === 'approved'
						? workflowStep.approvedStepKey
						: workflowStep.rejectedStepKey
				const targetIndex = resolveWorkflowStepIndex(stepKeys, targetKey)
				const target = run.workflow.steps[targetIndex]
				if (
					target.kind !== 'mutation' &&
					target.kind !== 'action' &&
					target.kind !== 'notify'
				)
					throw new Error('Approval branch target must be a callback step')
				const evidence = await step.runQuery(
					internal.decisions.listForWorkflow,
					{ runId: run._id, stepKey: lastDecisionStepKey ?? workflowStep.key },
					{ name: `evidence:${workflowStep.key}` },
				)
				failedStepKey = target.key
				await executeCallback(step, target, {
					...callbackInput,
					decision: {
						stepKey: lastDecisionStepKey ?? workflowStep.key,
						outcome: lastDecision,
						evidence,
						...(terminalEvidence === undefined ? {} : { terminalEvidence }),
					},
				})
				failedStepKey = undefined
				if (lastDecision === 'rejected' || lastDecision === 'expired') break
				index += 1
				continue
			}

			await step.runMutation(
				internal.requests.recordExecutionTerminal,
				{ runId: run._id, outcome: 'completed' },
				{ name: 'recordExecutionCompleted' },
			)
			return null
		} catch (error) {
			await step.runMutation(
				internal.requests.recordExecutionTerminal,
				{
					runId: input.runId,
					outcome: 'failed',
					...(failedStepKey === undefined ? {} : { failedStepKey }),
				},
				{ name: 'recordExecutionFailed' },
			)
			throw error
		}
	},
})

type CallbackStep = Extract<
	Doc<'approvalRuns'>['workflow']['steps'][number],
	{ kind: 'mutation' | 'action' | 'notify' }
>

function buildCallbackInput(run: Doc<'approvalRuns'>): ApprovalCallbackInput {
	return {
		runId: run._id,
		scopeRef: run.scopeRef,
		resourceType: run.resourceType,
		resourceRef: run.resourceRef,
		...(run.metadata === undefined ? {} : { metadata: run.metadata }),
	}
}

async function executeCallback(
	step: WorkflowCtx,
	workflowStep: CallbackStep,
	input: ApprovalCallbackInput,
): Promise<void> {
	if (workflowStep.callback.kind === 'mutation') {
		await step.runMutation(
			callbackReference<'mutation'>(workflowStep.callback.handle),
			input,
			{ name: workflowStep.key },
		)
		return
	}
	await step.runAction(
		callbackReference<'action'>(workflowStep.callback.handle),
		input,
		{ name: workflowStep.key, retry: workflowStep.callback.retry },
	)
}
