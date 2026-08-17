// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { anyApi, defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'

import approvalsSchema from '../src/components/approvals/schema'
import type { ComponentApi as ApprovalsComponentApi } from '../src/components/approvals/_generated/component'
import { approvalCallbackInput } from '../src/components/approvals/client'
import {
	canTransitionApprovalRun,
	classifyPendingRunAt,
} from '../src/components/approvals/functions'
import foundationSchema from '../src/components/foundation/schema'

const foundationModules = import.meta.glob(
	'../src/components/foundation/**/*.ts',
)
const approvalsModules = import.meta.glob('../src/components/approvals/**/*.ts')
type ApprovalsApiHasHealth = ApprovalsComponentApi extends {
	health: { check: unknown }
}
	? true
	: false
const approvalsApiHasHealth: ApprovalsApiHasHealth = true

describe('foundation component on the real Convex runtime', () => {
	it('reports ready from its status query', async () => {
		const t = convexTest(foundationSchema, foundationModules)
		expect(await t.query(anyApi.functions.status, {})).toBe('ready')
	})

	it('owns zero tables by design', () => {
		expect(Object.keys(foundationSchema.tables)).toEqual([])
	})
})

describe('approvals component contracts', () => {
	it('validates the exact decision evidence sent to callbacks', () => {
		expect(
			approvalCallbackInput.parse({
				runId: 'run_1',
				scopeRef: 'scope_1',
				resourceType: 'document',
				resourceRef: 'document_1',
				decision: {
					stepKey: 'managerDecision',
					outcome: 'approved',
					evidence: [
						{
							stepKey: 'managerDecision',
							actorRef: 'manager_1',
							decision: 'approved',
							reason: 'Ready',
							decidedAt: 1_000,
						},
					],
				},
			}),
		).toMatchObject({
			decision: { evidence: [{ stepKey: 'managerDecision' }] },
		})
	})

	it('exposes the health query in its generated component API', () => {
		expect(approvalsApiHasHealth).toBe(true)
	})

	it('verifies the deployed schema version and required decision indexes', async () => {
		const t = convexTest(approvalsSchema, approvalsModules)
		expect(await t.query(anyApi.health.check, {})).toEqual({
			status: 'ready',
			schemaVersion: 1,
			requiredIndexes: [
				'by_runId_and_decidedAt',
				'by_runId_and_stepKey_and_actor_actorRef',
			],
		})
	})

	it('explains when the installed component schema lacks required indexes', async () => {
		const staleSchema = defineSchema({
			approvalDecisions: defineTable(v.any()),
		})
		const t = convexTest(staleSchema, approvalsModules)
		await expect(t.query(anyApi.health.check, {})).rejects.toThrow(
			'cvx-kit approvals schema v1 is not installed with its required indexes',
		)
	})

	it('declares exactly its two evidence tables', () => {
		expect(Object.keys(approvalsSchema.tables).sort()).toEqual([
			'approvalDecisions',
			'approvalRuns',
		])
	})

	it('paginates approval runs within scope and state boundaries', async () => {
		const t = convexTest(approvalsSchema, approvalsModules)
		const workflow = {
			schemaVersion: 1 as const,
			compatibilityKey: 'paginationTest',
			name: 'paginationTest',
			steps: [
				{
					kind: 'decision' as const,
					key: 'review',
					decisions: ['approved', 'rejected'] as (
						| 'approved'
						| 'rejected'
					)[],
					quorum: { kind: 'count' as const, approvals: 1 },
					makerChecker: false,
				},
			],
		}
		const insertRun = (scopeRef: string, state: 'pending' | 'approved') =>
			t.run((ctx) => {
				const now = Date.now()
				return ctx.db.insert('approvalRuns', {
					scopeRef,
					resourceType: 'document',
					resourceRef: `${scopeRef}-${state}-${now}`,
					requester: { actorRef: 'requester', capabilities: [] },
					workflow,
					state,
					createdAt: now,
					updatedAt: now,
				})
			})

		const oldestPending = await insertRun('scope-a', 'pending')
		await insertRun('scope-a', 'approved')
		await insertRun('scope-b', 'pending')
		const newestPending = await insertRun('scope-a', 'pending')
		const first = await t.query(anyApi.requests.list, {
			scopeRef: 'scope-a',
			state: 'pending',
			paginationOpts: { cursor: null, numItems: 1 },
		})
		expect(first.page.map((run: { _id: string }) => run._id)).toEqual([
			newestPending,
		])

		await insertRun('scope-a', 'pending')
		const second = await t.query(anyApi.requests.list, {
			scopeRef: 'scope-a',
			state: 'pending',
			paginationOpts: { cursor: first.continueCursor, numItems: 10 },
		})
		expect(second.page.map((run: { _id: string }) => run._id)).toEqual([
			oldestPending,
		])
		expect(second.isDone).toBe(true)
	})

	it('only pending runs may transition, and only to legal successors', () => {
		expect(canTransitionApprovalRun('pending', 'approved')).toBe(true)
		expect(canTransitionApprovalRun('pending', 'canceled')).toBe(true)
		expect(canTransitionApprovalRun('approved', 'pending')).toBe(false)
		expect(canTransitionApprovalRun('rejected', 'approved')).toBe(false)
		expect(canTransitionApprovalRun('canceled', 'expired')).toBe(false)
	})

	it('classifies pending runs by their expiry deadline', () => {
		const now = 1_000_000
		expect(classifyPendingRunAt(now, now + 1)).toBe('pending')
		expect(classifyPendingRunAt(now, now)).toBe('expired')
		expect(classifyPendingRunAt(now, now - 1)).toBe('expired')
	})
})
