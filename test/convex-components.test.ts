// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { anyApi, defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'

import approvalsSchema from '../src/components/approvals/schema'
import type { ComponentApi as ApprovalsComponentApi } from '../src/components/approvals/_generated/component'
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
