import { AuditLog, type AuditEventInput } from 'convex-audit-log'
import { v } from 'convex/values'

import { components } from './_generated/api'
import { mutation, query, type MutationCtx } from './_generated/server'
import {
	APPROVAL_AUDIT_RETENTION_CATEGORY,
	MAX_APPROVAL_AUDIT_CLEANUP_BATCH_SIZE,
	MAX_APPROVAL_AUDIT_RETENTION_DAYS,
	MIN_APPROVAL_AUDIT_RETENTION_DAYS,
} from './constants'

export type ApprovalAuditTransition = Readonly<{
	action: string
	actorRef?: string
	runId: string
	resourceType: string
	resourceRef: string
	transition: string
	severity?: AuditEventInput['severity']
}>

export type ApprovalAuditProjection = Readonly<{
	action: string
	actorRef?: string
	correlationKey: string
	transition: string
}>

export const approvalAudit = new AuditLog(components.auditLog, {
	samplingEnabled: false,
})

export const history = query({
	args: {
		resourceType: v.string(),
		resourceRef: v.string(),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			action: v.string(),
			actorRef: v.optional(v.string()),
			correlationKey: v.string(),
			transition: v.string(),
		}),
	),
	handler: async (ctx, input) => {
		const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 100), 100))
		const events = await approvalAudit.queryByResource(ctx, {
			resourceType: input.resourceType,
			resourceId: input.resourceRef,
			limit,
		})
		const unique = new Map<string, ApprovalAuditProjection>()
		for (const event of events) {
			const projection = auditProjection(event)
			if (projection) unique.set(projection.correlationKey, projection)
		}
		return [...unique.values()]
	},
})

export const cleanup = mutation({
	args: {
		olderThanDays: v.number(),
		batchSize: v.number(),
	},
	returns: v.number(),
	handler: (ctx, input) => {
		const olderThanDays = boundedInteger(
			input.olderThanDays,
			MIN_APPROVAL_AUDIT_RETENTION_DAYS,
			MAX_APPROVAL_AUDIT_RETENTION_DAYS,
			'olderThanDays',
		)
		const batchSize = boundedInteger(
			input.batchSize,
			1,
			MAX_APPROVAL_AUDIT_CLEANUP_BATCH_SIZE,
			'batchSize',
		)
		return approvalAudit.cleanup(ctx, {
			olderThanDays,
			batchSize,
			retentionCategory: APPROVAL_AUDIT_RETENTION_CATEGORY,
		})
	},
})

export function approvalAuditEvent(
	input: ApprovalAuditTransition,
): AuditEventInput {
	return {
		action: input.action,
		...(input.actorRef === undefined ? {} : { actorId: input.actorRef }),
		resourceType: input.resourceType,
		resourceId: input.resourceRef,
		severity: input.severity ?? 'info',
		tags: ['approvals'],
		retentionCategory: APPROVAL_AUDIT_RETENTION_CATEGORY,
		metadata: {
			correlationKey: `${input.runId}:${input.transition}`,
			runId: input.runId,
			transition: input.transition,
		},
	}
}

export async function logApprovalTransition(
	ctx: MutationCtx,
	input: ApprovalAuditTransition,
): Promise<void> {
	await approvalAudit.log(ctx, approvalAuditEvent(input))
}

function boundedInteger(
	value: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum)
		throw new Error(
			`${name} must be an integer between ${minimum} and ${maximum}`,
		)
	return value
}

function auditProjection(event: unknown): ApprovalAuditProjection | null {
	if (!event || typeof event !== 'object') return null
	const value = event as Record<string, unknown>
	const metadata = value.metadata
	if (!metadata || typeof metadata !== 'object') return null
	const details = metadata as Record<string, unknown>
	if (
		typeof value.action !== 'string' ||
		typeof details.correlationKey !== 'string' ||
		typeof details.transition !== 'string'
	)
		return null
	return {
		action: value.action,
		...(typeof value.actorId === 'string' ? { actorRef: value.actorId } : {}),
		correlationKey: details.correlationKey,
		transition: details.transition,
	}
}
