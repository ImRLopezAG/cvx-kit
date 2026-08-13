// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { anyApi } from 'convex/server'
import { describe, expect, it } from 'vite-plus/test'

import approvalsSchema from '../src/components/approvals/schema'
import {
	canTransitionApprovalRun,
	classifyPendingRunAt,
} from '../src/components/approvals/functions'
import foundationSchema from '../src/components/foundation/schema'

const foundationModules = import.meta.glob(
	'../src/components/foundation/**/*.ts',
)

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
