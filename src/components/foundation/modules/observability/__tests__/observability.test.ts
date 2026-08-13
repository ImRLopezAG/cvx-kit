import { describe, expect, it, vi } from 'vite-plus/test'

import { Observability } from '../observability'

describe('Foundation Observability', () => {
	it('emits bounded semantic metadata without payloads', async () => {
		const emit = vi.fn()
		const observability = new Observability({
			enabled: true,
			clock: tickingClock(),
			classifyError: () => ({
				outcome: 'failed',
				errorCode: 'UNEXPECTED_ERROR',
			}),
			emit,
		})

		await expect(
			observability.observe(
				{ operation: 'assignments.claim', classification: 'writer' },
				() => 'claimed',
			),
		).resolves.toBe('claimed')
		expect(emit).toHaveBeenCalledWith({
			operation: 'assignments.claim',
			classification: 'writer',
			outcome: 'completed',
			durationMs: 5,
		})
	})

	it('classifies denial and preserves the original failure', async () => {
		const emit = vi.fn()
		const original = new Error('sensitive reason')
		const observability = new Observability({
			enabled: true,
			clock: tickingClock(),
			classifyError: () => ({ outcome: 'denied', errorCode: 'FORBIDDEN' }),
			emit,
		})

		await expect(
			observability.observe(
				{ operation: 'assignments.assign', classification: 'admin' },
				() => {
					throw original
				},
			),
		).rejects.toBe(original)
		expect(JSON.stringify(emit.mock.calls)).not.toContain('sensitive reason')
	})

	it('drops invalid semantic fields and contains emitter failures', async () => {
		const emit = vi.fn(() => {
			throw new Error('telemetry unavailable')
		})
		const observability = new Observability({
			enabled: true,
			classifyError: () => ({
				outcome: 'failed',
				errorCode: 'UNEXPECTED_ERROR',
			}),
			emit,
		})

		await expect(
			observability.observe(
				{ operation: 'contains secret whitespace', classification: 'writer' },
				() => 'unchanged',
			),
		).resolves.toBe('unchanged')
		expect(emit).not.toHaveBeenCalled()
	})
})

function tickingClock(): () => number {
	let now = 10
	return () => (now += 5)
}
