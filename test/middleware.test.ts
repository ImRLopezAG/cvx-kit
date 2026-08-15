import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import {
	Foundation,
	type AuditEntryInput,
} from '../src/components/foundation/client'
import { KitError } from '../src/errors'
import { rateLimit, type RateLimiterLike } from '../src/middleware'

type Ctx = { actorId: string; tenant?: string }

function fakeLimiter(allow: boolean, retryAfter?: number) {
	const calls: { name: string; key?: string }[] = []
	const limiter: RateLimiterLike = {
		limit: async (_ctx, name, options) => {
			calls.push({ name, key: options?.key })
			return allow ? { ok: true } : { ok: false, retryAfter }
		},
	}
	return { limiter, calls }
}

function commandHarness(middleware: never[]) {
	const auditEntries: AuditEntryInput[] = []
	const calls: string[] = []
	const { Command } = new Foundation(
		{ functions: { status: 'status' } },
		{
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'denied', errorCode: 'RATE_LIMITED' }),
				writeAudit: (_context, entry) => {
					auditEntries.push(entry)
				},
			},
		},
	)
	const operations = {
		'notes.touch': Command.operation({
			command: z.object({}).strict(),
			result: z.object({ ok: z.literal(true) }).strict(),
			classification: 'business',
			middleware,
			audit: () => ({
				operation: 'notes.touch',
				actorId: 'user_1',
				aggregate: { type: 'note', id: 'n_1' },
			}),
		}),
	} as const
	const commands = new Command<Ctx, typeof operations>(operations)
	const touch = commands.exec({
		operation: 'notes.touch',
		handler: async () => {
			calls.push('handler')
			return { ok: true as const }
		},
	})
	return { touch, calls, auditEntries }
}

describe('rateLimit middleware', () => {
	it('passes through under the limit, keyed by ctx.tenant by default', async () => {
		const { limiter, calls } = fakeLimiter(true)
		const { touch, calls: run } = commandHarness([
			rateLimit({ limiter, name: 'touch' }) as never,
		])
		await touch({ actorId: 'u', tenant: 'org_1' }, {})
		expect(run).toEqual(['handler'])
		expect(calls).toEqual([{ name: 'touch', key: 'org_1' }])
	})

	it('over the limit: handler never runs, audit skipped, RATE_LIMITED thrown', async () => {
		const { limiter } = fakeLimiter(false, 1200)
		const { touch, calls, auditEntries } = commandHarness([
			rateLimit({ limiter, name: 'touch' }) as never,
		])
		await expect(
			touch({ actorId: 'u', tenant: 'org_1' }, {}),
		).rejects.toThrow(/RATE_LIMITED|exceeded/)
		expect(calls).toEqual([])
		expect(auditEntries).toEqual([])
	})

	it('custom key fn receives the ctx', async () => {
		const { limiter, calls } = fakeLimiter(true)
		const { touch } = commandHarness([
			rateLimit({
				limiter,
				name: 'touch',
				key: (ctx) => `actor:${(ctx as Ctx).actorId}`,
			}) as never,
		])
		await touch({ actorId: 'u_7' }, {})
		expect(calls[0]?.key).toBe('actor:u_7')
	})

	it('no key fn and no ctx.tenant is a configuration error, not a shared bucket', async () => {
		const { limiter, calls } = fakeLimiter(true)
		const { touch, calls: run } = commandHarness([
			rateLimit({ limiter, name: 'touch' }) as never,
		])
		await expect(touch({ actorId: 'u' }, {})).rejects.toThrow(KitError)
		await expect(touch({ actorId: 'u' }, {})).rejects.toThrow(
			/RATE_LIMIT_KEY_MISSING|no key/,
		)
		expect(calls).toEqual([])
		expect(run).toEqual([])
	})

	it('onLimit observes the rejection before the throw', async () => {
		const { limiter } = fakeLimiter(false, 500)
		const seen: number[] = []
		const { touch } = commandHarness([
			rateLimit({
				limiter,
				name: 'touch',
				onLimit: (status) => {
					seen.push(status.retryAfter ?? -1)
				},
			}) as never,
		])
		await expect(
			touch({ actorId: 'u', tenant: 'org_1' }, {}),
		).rejects.toThrow(/exceeded/)
		expect(seen).toEqual([500])
	})

	it('works in the registry-wide slot too', async () => {
		const { limiter, calls } = fakeLimiter(true)
		const auditEntries: AuditEntryInput[] = []
		const { Command } = new Foundation(
			{ functions: { status: 'status' } },
			{
				observability: {
					enabled: false,
					classifyError: () => ({
						outcome: 'denied',
						errorCode: 'RATE_LIMITED',
					}),
					writeAudit: (_context, entry) => {
						auditEntries.push(entry)
					},
				},
			},
		)
		const operations = {
			'notes.touch': Command.operation({
				command: z.object({}).strict(),
				result: z.object({ ok: z.literal(true) }).strict(),
				classification: 'business',
				audit: () => null,
			}),
		} as const
		const commands = new Command<Ctx, typeof operations>(operations, {
			middleware: [rateLimit({ limiter, name: 'global' }) as never],
		})
		const touch = commands.exec({
			operation: 'notes.touch',
			handler: async () => ({ ok: true as const }),
		})
		await touch({ actorId: 'u', tenant: 'org_9' }, {})
		expect(calls).toEqual([{ name: 'global', key: 'org_9' }])
	})
})
