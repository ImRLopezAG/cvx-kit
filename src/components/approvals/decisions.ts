import { WorkflowManager, type WorkflowId } from '@convex-dev/workflow'
import { zodToConvex } from 'convex-helpers/server/zod4'
import { v } from 'convex/values'

import { components, internal } from './_generated/api'
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type QueryCtx,
} from './_generated/server'
import { logApprovalTransition } from './audit'
import {
	APPROVAL_DECISIONS,
	APPROVAL_RUN_STATES,
	type ApprovalRunState,
} from './constants'
import { canTransitionApprovalRun, classifyPendingRunAt } from './functions'
import { approvalActor, approvalDecision, approvalReason } from './validators'
import {
	approvalDecisionEventName,
	evaluateDecisionOutcome,
} from './workflow_steps'

export const decide = mutation({
	args: {
		runId: v.id('approvalRuns'),
		decision: zodToConvex(approvalDecision),
		reason: v.optional(zodToConvex(approvalReason)),
		actor: zodToConvex(approvalActor),
		compatibilityKey: v.string(),
	},
	returns: v.object({
		state: v.union(
			v.literal(APPROVAL_RUN_STATES[0]),
			v.literal(APPROVAL_RUN_STATES[1]),
			v.literal(APPROVAL_RUN_STATES[2]),
			v.literal(APPROVAL_RUN_STATES[3]),
			v.literal(APPROVAL_RUN_STATES[4]),
		),
	}),
	handler: async (ctx, input) => {
		const run = await ctx.db.get(input.runId)
		if (!run) throw new Error('Approval request not found')
		assertCompatible(run.workflow.compatibilityKey, input.compatibilityKey)
		const step = run.workflow.steps.find(
			(candidate) =>
				candidate.kind === 'decision' && candidate.key === run.currentStepKey,
		)
		if (!step || step.kind !== 'decision')
			throw new Error('Approval request is not waiting for a decision')

		const prior = await ctx.db
			.query('approvalDecisions')
			.withIndex('by_runId_and_stepKey_and_actor_actorRef', (query) =>
				query
					.eq('runId', run._id)
					.eq('stepKey', step.key)
					.eq('actor.actorRef', input.actor.actorRef),
			)
			.unique()
		if (prior) {
			if (prior.decision !== input.decision)
				throw new Error('Actor already submitted a contradictory decision')
			return {
				state: run.state as 'pending' | 'approved' | 'rejected' | 'expired',
			}
		}
		if (run.state !== 'pending')
			throw new Error(`Approval request is already ${run.state}`)
		if (
			run.expiresAt !== undefined &&
			classifyPendingRunAt(Date.now(), run.expiresAt) === 'expired'
		)
			return claimExpiry(ctx, run, step.key)
		if (!step.decisions.includes(input.decision))
			throw new Error('Decision is not allowed by this workflow step')
		if (step.makerChecker && input.actor.actorRef === run.requester.actorRef)
			throw new Error('Requester cannot decide this approval step')

		const decidedAt = Date.now()
		await ctx.db.insert('approvalDecisions', {
			runId: run._id,
			stepKey: step.key,
			actor: input.actor,
			decision: input.decision,
			...(input.reason === undefined ? {} : { reason: input.reason }),
			decidedAt,
		})
		const evidence = await ctx.db
			.query('approvalDecisions')
			.withIndex('by_runId_and_stepKey_and_decidedAt', (query) =>
				query.eq('runId', run._id).eq('stepKey', step.key),
			)
			.collect()
		const outcome = evaluateDecisionOutcome(
			evidence.map((item) => ({
				actorRef: item.actor.actorRef,
				decision: item.decision,
			})),
			step.quorum.approvals,
		)
		await logApprovalTransition(ctx, {
			action: `approval.decision.${input.decision}`,
			actorRef: input.actor.actorRef,
			runId: run._id,
			resourceType: run.resourceType,
			resourceRef: run.resourceRef,
			transition: `${step.key}:${input.actor.actorRef}:${input.decision}`,
		})
		if (!outcome) return { state: 'pending' as const }
		const terminal = isTerminalDecision(run, step.key, outcome)
		await finishDecision(ctx, run, step.key, outcome, terminal, {
			actorRef: input.actor.actorRef,
			decision: input.decision,
			...(input.reason === undefined ? {} : { reason: input.reason }),
			decidedAt,
		})
		return terminal ? { state: outcome } : { state: 'pending' as const }
	},
})

export const list = query({
	args: { runId: v.id('approvalRuns') },
	returns: v.array(
		v.object({
			stepKey: v.string(),
			actorRef: v.string(),
			decision: zodToConvex(approvalDecision),
			reason: v.optional(zodToConvex(approvalReason)),
			decidedAt: v.number(),
		}),
	),
	handler: (ctx, input) => listDecisionEvidence(ctx, input.runId),
})

export const listForWorkflow = internalQuery({
	args: { runId: v.id('approvalRuns'), stepKey: v.string() },
	returns: v.array(
		v.object({
			stepKey: v.string(),
			actorRef: v.string(),
			decision: zodToConvex(approvalDecision),
			reason: v.optional(zodToConvex(approvalReason)),
			decidedAt: v.number(),
		}),
	),
	handler: (ctx, input) =>
		listDecisionEvidenceForStep(ctx, input.runId, input.stepKey),
})

export const enter = internalMutation({
	args: {
		runId: v.id('approvalRuns'),
		stepKey: v.string(),
		workflowId: v.string(),
		expiresAfterMs: v.optional(v.number()),
	},
	returns: v.object({
		state: v.union(
			v.literal(APPROVAL_RUN_STATES[0]),
			v.literal(APPROVAL_RUN_STATES[1]),
			v.literal(APPROVAL_RUN_STATES[2]),
			v.literal(APPROVAL_RUN_STATES[3]),
			v.literal(APPROVAL_RUN_STATES[4]),
		),
		expiresAt: v.optional(v.number()),
	}),
	handler: async (ctx, input) => {
		const run = await ctx.db.get(input.runId)
		if (!run) throw new Error('Approval request not found')
		if (run.workflowId !== input.workflowId)
			throw new Error('Approval workflow linkage is incomplete')
		if (run.state !== 'pending')
			return {
				state: run.state as ApprovalRunState,
				expiresAt: run.expiresAt,
			}
		const configuredExpiresAt = Number(run.metadata?.approvalExpiresAt)
		const expiresAt = Number.isFinite(configuredExpiresAt)
			? configuredExpiresAt
			: input.expiresAfterMs === undefined
				? undefined
				: Date.now() + input.expiresAfterMs
		await ctx.db.patch(run._id, {
			currentStepKey: input.stepKey,
			expiresAt,
			updatedAt: Date.now(),
		})
		await logApprovalTransition(ctx, {
			action: 'approval.waiting',
			runId: run._id,
			resourceType: run.resourceType,
			resourceRef: run.resourceRef,
			transition: `${input.stepKey}:waiting`,
		})
		if (expiresAt !== undefined)
			await ctx.scheduler.runAt(expiresAt, internal.decisions.expire, {
				runId: run._id,
				stepKey: input.stepKey,
			})
		return {
			state: 'pending' as const,
			...(expiresAt === undefined ? {} : { expiresAt }),
		}
	},
})

export const expire = internalMutation({
	args: { runId: v.id('approvalRuns'), stepKey: v.string() },
	returns: v.object({
		state: v.union(
			v.literal('missing'),
			v.literal(APPROVAL_RUN_STATES[0]),
			v.literal(APPROVAL_RUN_STATES[1]),
			v.literal(APPROVAL_RUN_STATES[2]),
			v.literal(APPROVAL_RUN_STATES[3]),
			v.literal(APPROVAL_RUN_STATES[4]),
		),
	}),
	handler: async (ctx, input) => {
		const run = await ctx.db.get(input.runId)
		if (!run) return { state: 'missing' as const }
		if (
			run.state !== 'pending' ||
			run.currentStepKey !== input.stepKey ||
			run.expiresAt === undefined ||
			classifyPendingRunAt(Date.now(), run.expiresAt) === 'pending'
		)
			return { state: run.state as ApprovalRunState }
		return claimExpiry(ctx, run, input.stepKey)
	},
})

const approvalWorkflow = new WorkflowManager(components.workflow)

async function claimExpiry(
	ctx: import('./_generated/server').MutationCtx,
	run: import('./_generated/dataModel').Doc<'approvalRuns'>,
	stepKey: string,
): Promise<{ state: 'expired' }> {
	if (!canTransitionApprovalRun(run.state, 'expired'))
		throw new Error(`Approval request cannot transition from ${run.state}`)
	const now = Date.now()
	await ctx.db.patch(run._id, {
		state: 'expired',
		expiresAt: undefined,
		updatedAt: now,
		terminalAt: now,
	})
	await logApprovalTransition(ctx, {
		action: 'approval.expired',
		runId: run._id,
		resourceType: run.resourceType,
		resourceRef: run.resourceRef,
		transition: `${stepKey}:expired`,
	})
	if (!run.workflowId) throw new Error('Approval workflow is not linked')
	await approvalWorkflow.sendEvent(ctx, {
		workflowId: run.workflowId as WorkflowId,
		name: approvalDecisionEventName(run._id, stepKey),
		validator: v.object({ outcome: v.literal(APPROVAL_RUN_STATES[3]) }),
		value: { outcome: 'expired' },
	})
	return { state: 'expired' }
}

async function finishDecision(
	ctx: import('./_generated/server').MutationCtx,
	run: import('./_generated/dataModel').Doc<'approvalRuns'>,
	stepKey: string,
	outcome: 'approved' | 'rejected',
	terminal: boolean,
	terminalEvidence: {
		actorRef: string
		decision: 'approved' | 'rejected'
		reason?: string
		decidedAt: number
	},
): Promise<void> {
	if (terminal) {
		if (!canTransitionApprovalRun(run.state, outcome))
			throw new Error(`Approval request cannot transition from ${run.state}`)
		const now = Date.now()
		await ctx.db.patch(run._id, {
			state: outcome,
			expiresAt: undefined,
			updatedAt: now,
			terminalAt: now,
		})
		await logApprovalTransition(ctx, {
			action: `approval.${outcome}`,
			runId: run._id,
			resourceType: run.resourceType,
			resourceRef: run.resourceRef,
			transition: `${stepKey}:terminal:${outcome}`,
		})
	}
	if (!run.workflowId) throw new Error('Approval workflow is not linked')
	await approvalWorkflow.sendEvent(ctx, {
		workflowId: run.workflowId as WorkflowId,
		name: approvalDecisionEventName(run._id, stepKey),
		validator: v.object({
			outcome: v.union(
				v.literal(APPROVAL_DECISIONS[0]),
				v.literal(APPROVAL_DECISIONS[1]),
			),
			terminalEvidence: v.object({
				actorRef: v.string(),
				decision: zodToConvex(approvalDecision),
				reason: v.optional(zodToConvex(approvalReason)),
				decidedAt: v.number(),
			}),
		}),
		value: { outcome, terminalEvidence },
	})
}

function assertCompatible(actual: string, expected: string): void {
	if (actual !== expected)
		throw new Error(
			`Approval workflow compatibility mismatch: expected ${expected}, received ${actual}`,
		)
}

async function listDecisionEvidence(
	ctx: QueryCtx,
	runId: import('./_generated/dataModel').Id<'approvalRuns'>,
) {
	const decisions = await ctx.db
		.query('approvalDecisions')
		.withIndex('by_runId_and_decidedAt', (query) => query.eq('runId', runId))
		.collect()
	return decisions.map((decision) => ({
		stepKey: decision.stepKey,
		actorRef: decision.actor.actorRef,
		decision: decision.decision,
		...(decision.reason === undefined ? {} : { reason: decision.reason }),
		decidedAt: decision.decidedAt,
	}))
}

async function listDecisionEvidenceForStep(
	ctx: QueryCtx,
	runId: import('./_generated/dataModel').Id<'approvalRuns'>,
	stepKey: string,
) {
	const decisions = await ctx.db
		.query('approvalDecisions')
		.withIndex('by_runId_and_stepKey_and_decidedAt', (query) =>
			query.eq('runId', runId).eq('stepKey', stepKey),
		)
		.collect()
	return decisions.map((decision) => ({
		stepKey: decision.stepKey,
		actorRef: decision.actor.actorRef,
		decision: decision.decision,
		...(decision.reason === undefined ? {} : { reason: decision.reason }),
		decidedAt: decision.decidedAt,
	}))
}

function isTerminalDecision(
	run: import('./_generated/dataModel').Doc<'approvalRuns'>,
	stepKey: string,
	outcome: 'approved' | 'rejected',
): boolean {
	if (outcome === 'rejected') return true
	const currentIndex = run.workflow.steps.findIndex(
		(step) => step.kind === 'decision' && step.key === stepKey,
	)
	return !run.workflow.steps
		.slice(currentIndex + 1)
		.some((step) => step.kind === 'decision')
}
