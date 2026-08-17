import { WorkflowManager, type WorkflowId } from '@convex-dev/workflow'
import { zodToConvex } from 'convex-helpers/server/zod4'
import { paginator } from 'convex-helpers/server/pagination'
import {
	paginationOptsValidator,
	paginationResultValidator,
} from 'convex/server'
import { v } from 'convex/values'

import { components, internal } from './_generated/api'
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
} from './_generated/server'
import { logApprovalTransition } from './audit'
import schema from './schema'
import { APPROVAL_EXECUTION_STATES, APPROVAL_RUN_STATES } from './constants'
import { canTransitionApprovalRun } from './functions'
import {
	approvalActor,
	approvalMetadata,
	approvalName,
	approvalReference,
	approvalRunDocument,
	approvalRunState,
	approvalWorkflowDescriptor,
} from './validators'

export const start = mutation({
	args: {
		scopeRef: zodToConvex(approvalReference),
		resourceType: zodToConvex(approvalReference),
		resourceRef: zodToConvex(approvalReference),
		requester: zodToConvex(approvalActor),
		metadata: v.optional(zodToConvex(approvalMetadata)),
		workflow: zodToConvex(approvalWorkflowDescriptor),
	},
	returns: v.object({ runId: v.id('approvalRuns') }),
	handler: async (ctx, input) => {
		const now = Date.now()
		const runId = await ctx.db.insert('approvalRuns', {
			...input,
			state: 'pending',
			createdAt: now,
			updatedAt: now,
		})
		const workflowId: WorkflowId = await approvalWorkflow.start(
			ctx,
			internal.workflow.run,
			{ runId },
			{ startAsync: true },
		)
		await ctx.db.patch(runId, { workflowId, updatedAt: Date.now() })
		await logApprovalTransition(ctx, {
			action: 'approval.requested',
			actorRef: input.requester.actorRef,
			runId,
			resourceType: input.resourceType,
			resourceRef: input.resourceRef,
			transition: 'requested',
		})
		return { runId }
	},
})

export const cancel = mutation({
	args: {
		runId: v.id('approvalRuns'),
		actor: zodToConvex(approvalActor),
		compatibilityKey: v.string(),
	},
	returns: v.object({ state: v.literal(APPROVAL_RUN_STATES[4]) }),
	handler: async (ctx, input) => {
		const run = await ctx.db.get(input.runId)
		if (!run) throw new Error('Approval request not found')
		assertCompatible(run.workflow.compatibilityKey, input.compatibilityKey)
		if (run.state !== 'pending') {
			if (run.state === 'canceled') return { state: 'canceled' as const }
			throw new Error(`Approval request is already ${run.state}`)
		}
		if (!run.workflowId) throw new Error('Approval workflow is not linked')
		await approvalWorkflow.cancel(ctx, run.workflowId as WorkflowId)
		if (!canTransitionApprovalRun(run.state, 'canceled'))
			throw new Error(`Approval request cannot transition from ${run.state}`)
		const now = Date.now()
		await ctx.db.patch(run._id, {
			state: 'canceled',
			expiresAt: undefined,
			updatedAt: now,
			terminalAt: now,
		})
		await logApprovalTransition(ctx, {
			action: 'approval.canceled',
			actorRef: input.actor.actorRef,
			runId: run._id,
			resourceType: run.resourceType,
			resourceRef: run.resourceRef,
			transition: 'canceled',
		})
		return { state: 'canceled' as const }
	},
})

export const restart = mutation({
	args: { runId: v.id('approvalRuns'), compatibilityKey: v.string() },
	returns: v.null(),
	handler: async (ctx, input) => {
		const run = await ctx.db.get(input.runId)
		if (!run) throw new Error('Approval request not found')
		assertCompatible(run.workflow.compatibilityKey, input.compatibilityKey)
		if (!run.workflowId) throw new Error('Approval workflow is not linked')
		if (!run.executionFailedStepKey)
			throw new Error('Approval workflow has no failed step to restart')
		await approvalWorkflow.restart(ctx, run.workflowId as WorkflowId, {
			from: run.executionFailedStepKey,
			startAsync: true,
		})
		return null
	},
})

export const status = query({
	args: { runId: v.id('approvalRuns'), compatibilityKey: v.string() },
	returns: v.union(v.null(), approvalStatusValidator()),
	handler: async (ctx, input) => {
		const run = await ctx.db.get(input.runId)
		if (!run) return null
		assertCompatible(run.workflow.compatibilityKey, input.compatibilityKey)
		const workflowStatus = run.workflowId
			? await approvalWorkflow.status(ctx, run.workflowId as WorkflowId)
			: null
		const execution = normalizeWorkflowStatus(workflowStatus)
		return { run, execution }
	},
})

export const list = query({
	args: {
		scopeRef: zodToConvex(approvalReference),
		state: v.optional(zodToConvex(approvalRunState)),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(approvalRunValidator()),
	handler: (ctx, input) =>
		paginator(ctx.db, schema)
			.query('approvalRuns')
			.withIndex('by_scopeRef_and_state', (query) =>
				input.state === undefined
					? query.eq('scopeRef', input.scopeRef)
					: query.eq('scopeRef', input.scopeRef).eq('state', input.state),
			)
			.order('desc')
			.paginate(input.paginationOpts),
})

export const getForWorkflow = internalQuery({
	args: { runId: v.id('approvalRuns') },
	returns: v.union(v.null(), approvalRunValidator()),
	handler: (ctx, input) => ctx.db.get(input.runId),
})

export const recordExecutionTerminal = internalMutation({
	args: {
		runId: v.id('approvalRuns'),
		outcome: v.union(
			v.literal(APPROVAL_EXECUTION_STATES[1]),
			v.literal(APPROVAL_EXECUTION_STATES[3]),
		),
		failedStepKey: v.optional(zodToConvex(approvalName)),
	},
	returns: v.null(),
	handler: async (ctx, input) => {
		const run = await ctx.db.get(input.runId)
		if (!run) throw new Error('Approval request not found')
		await ctx.db.patch(run._id, {
			executionFailedStepKey:
				input.outcome === 'failed' ? input.failedStepKey : undefined,
			updatedAt: Date.now(),
		})
		await logApprovalTransition(ctx, {
			action: `approval.execution.${input.outcome}`,
			runId: run._id,
			resourceType: run.resourceType,
			resourceRef: run.resourceRef,
			transition: `execution:${input.outcome}`,
			severity: input.outcome === 'failed' ? 'error' : 'info',
		})
		return null
	},
})

const approvalWorkflow = new WorkflowManager(components.workflow)

function normalizeWorkflowStatus(
	status: Awaited<ReturnType<typeof approvalWorkflow.status>> | null,
) {
	if (!status) return null
	switch (status.type) {
		case 'failed':
			return { type: 'failed' as const, error: status.error }
		case 'inProgress':
		case 'completed':
		case 'canceled':
			return { type: status.type }
	}
}

function approvalRunValidator() {
	return v.object({
		_id: v.id('approvalRuns'),
		_creationTime: v.number(),
		...zodToConvex(approvalRunDocument).fields,
	})
}

function workflowStatusValidator() {
	return v.union(
		v.object({ type: v.literal(APPROVAL_EXECUTION_STATES[0]) }),
		v.object({ type: v.literal(APPROVAL_EXECUTION_STATES[1]) }),
		v.object({ type: v.literal(APPROVAL_EXECUTION_STATES[2]) }),
		v.object({
			type: v.literal(APPROVAL_EXECUTION_STATES[3]),
			error: v.string(),
		}),
	)
}

function approvalStatusValidator() {
	return v.object({
		run: approvalRunValidator(),
		execution: v.union(v.null(), workflowStatusValidator()),
	})
}

function assertCompatible(actual: string, expected: string): void {
	if (actual !== expected)
		throw new Error(
			`Approval workflow compatibility mismatch: expected ${expected}, received ${actual}`,
		)
}
