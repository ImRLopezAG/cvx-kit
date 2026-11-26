// The places where the components parsed with Zod in v1 and now parse with `k` (U17): the public
// approval callback input, the compiled workflow descriptor, the audit event projection and the
// foundation telemetry filter. Each keeps its v1 outcome; failures now carry `{ code: 'VALIDATION' }`.
import { describe, expect, it, vi } from 'vite-plus/test'

import { approvalCallbackInput } from '../src/components/approvals/client'
import {
	approvalAuditEventProjection,
	approvalWorkflowDescriptor,
} from '../src/components/approvals/validators'
import {
	compileApprovalDescriptor,
	type CreateApprovalHandle,
} from '../src/components/approvals/workflow_steps'
import { emitSemanticEvent } from '../src/components/foundation/telemetry'
import { KValidationError } from '../src/k'

const callback = {
	runId: 'run_1',
	scopeRef: 'scope_1',
	resourceType: 'document',
	resourceRef: 'document_1',
}

function issuesOf(run: () => void) {
	try {
		run()
	} catch (cause) {
		if (cause instanceof KValidationError) return cause.data
		throw cause
	}
	throw new Error('expected a validation failure')
}

describe('approval callback input', () => {
	it('trims references and names before checking them', () => {
		expect(
			approvalCallbackInput.parse({ ...callback, runId: '  run_1 ', resourceType: ' document ' }),
		).toEqual(callback)
	})

	it('rejects blank, over-long and malformed fields with VALIDATION issues', () => {
		const data = issuesOf(() =>
			approvalCallbackInput.parse({
				...callback,
				runId: '   ',
				scopeRef: 'x'.repeat(257),
				resourceType: '1document',
			}),
		)
		expect(data.code).toBe('VALIDATION')
		expect(data.issues.map((issue) => [issue.path, issue.code])).toEqual([
			[['runId'], 'too_small'],
			[['scopeRef'], 'too_big'],
			[['resourceType'], 'invalid_format'],
		])
	})

	it('rejects unknown keys and bounds metadata', () => {
		expect(approvalCallbackInput.safeParse({ ...callback, extra: 1 }).success).toBe(false)
		const metadata = Object.fromEntries(
			Array.from({ length: 33 }, (_, index) => [`k${index}`, 'v']),
		)
		expect(approvalCallbackInput.safeParse({ ...callback, metadata }).success).toBe(false)
		expect(
			approvalCallbackInput.safeParse({ ...callback, metadata: { $reserved: 'v' } }).success,
		).toBe(false)
	})

	it('rejects non-finite evidence timestamps, as v1 z.number() did', () => {
		const decision = {
			stepKey: 'review',
			outcome: 'expired',
			evidence: [{ stepKey: 'review', actorRef: 'a', decision: 'approved', decidedAt: Infinity }],
		}
		expect(approvalCallbackInput.safeParse({ ...callback, decision }).success).toBe(false)
	})
})

describe('approval workflow descriptor', () => {
	const createHandle: CreateApprovalHandle = () => Promise.resolve('handle:callback')
	const reference = 'internal.callbacks.apply'
	const decision = {
		kind: 'decision' as const,
		key: 'review',
		decisions: ['approved', 'rejected'] as const,
		quorum: { kind: 'count' as const, approvals: 1 },
		makerChecker: false,
	}

	it('compiles a valid definition into a frozen descriptor', async () => {
		const descriptor = await compileApprovalDescriptor(
			{
				name: 'expense',
				compatibilityKey: 'expense',
				steps: [
					decision,
					{ kind: 'branch', key: 'route', approvedStepKey: 'pay', rejectedStepKey: 'notify' },
					// SAFETY: createHandle above never resolves the reference.
					{ kind: 'mutation', key: 'pay', handler: reference as never, retry: false },
					// SAFETY: createHandle above never resolves the reference.
					{ kind: 'notify', key: 'notify', handler: reference as never, retry: true },
				],
			},
			createHandle,
		)
		expect(descriptor.steps.map((step) => step.kind)).toEqual([
			'decision',
			'branch',
			'mutation',
			'notify',
		])
		expect(Object.isFrozen(descriptor)).toBe(true)
	})

	it('reports duplicate keys, duplicate decisions and illegal branches', () => {
		const data = issuesOf(() =>
			approvalWorkflowDescriptor.parse({
				schemaVersion: 1,
				compatibilityKey: 'expense',
				name: 'expense',
				steps: [
					{ ...decision, decisions: ['approved', 'approved'] },
					{ ...decision },
					{ kind: 'branch', key: 'route', approvedStepKey: 'missing', rejectedStepKey: 'review' },
				],
			}),
		)
		expect(data.issues.map((issue) => [issue.path, issue.message])).toEqual([
			[['steps', 0, 'decisions'], 'Duplicate decision value in step: review'],
			[['steps', 1, 'key'], 'Duplicate workflow step key: review'],
			[['steps', 2], 'Unknown branch target: missing'],
			[['steps', 2], 'Branch target must be a callback step: review'],
		])
	})

	it('rejects a non-positive quorum and an empty step list', () => {
		const base = { schemaVersion: 1, compatibilityKey: 'a', name: 'a' }
		expect(approvalWorkflowDescriptor.safeParse({ ...base, steps: [] }).success).toBe(false)
		expect(
			approvalWorkflowDescriptor.safeParse({
				...base,
				steps: [{ ...decision, quorum: { kind: 'count', approvals: 0 } }],
			}).success,
		).toBe(false)
	})
})

describe('audit event projection', () => {
	it('keeps only the projected fields and strips the rest', () => {
		expect(
			approvalAuditEventProjection.parse({
				action: 'approval.requested',
				actorId: 'user_1',
				resourceType: 'document',
				metadata: { correlationKey: 'run:requested', transition: 'requested', runId: 'run' },
			}),
		).toEqual({
			action: 'approval.requested',
			actorId: 'user_1',
			metadata: { correlationKey: 'run:requested', transition: 'requested' },
		})
	})

	it('rejects events without projection metadata', () => {
		expect(approvalAuditEventProjection.safeParse({ action: 'x', metadata: {} }).success).toBe(
			false,
		)
	})
})

describe('foundation telemetry', () => {
	it('keeps token strings, finite numbers and booleans and drops everything else', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
		try {
			emitSemanticEvent('command.done', {
				outcome: 'ok',
				free: 'has spaces',
				count: 3,
				bad: Number.NaN,
				infinite: Infinity,
				cached: false,
				missing: undefined,
			})
			expect(info).toHaveBeenCalledWith(
				JSON.stringify({ event: 'command.done', outcome: 'ok', count: 3, cached: false }),
			)
		} finally {
			info.mockRestore()
		}
	})
})
