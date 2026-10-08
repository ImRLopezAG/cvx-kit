import { z } from 'zod'
import { describe, expect, it } from 'vite-plus/test'

import { Foundation } from '../src/components/foundation/client'

function queryHarness() {
	const { Query } = new Foundation(
		{ functions: { status: 'status' } },
		{
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'UNEXPECTED' }),
			},
		},
	)
	return Query
}

describe('Foundation Query middleware', () => {
	it('wraps handlers with enrichment, kernel middleware before executor middleware', async () => {
		const Query = queryHarness()
		const calls: string[] = []
		type Ctx = { userId: string; traceId?: string }
		const queries = new Query<Ctx, { surface: string }>({
			defaults: { surface: 'reports' },
			middleware: [
				Query.middleware<Ctx>(async ({ metadata, next }) => {
					calls.push(`kernel:${z.object({ surface: z.string() }).parse(metadata).surface}`)
					return next({ context: { traceId: 't_9' } })
				}),
			],
			execute: async (execution) => {
				calls.push('execute:before')
				const result = await execution.run()
				calls.push('execute:after')
				return result
			},
		})
		const read = queries.exec({
			middleware: [
				Query.middleware<Ctx>(async ({ context, next }) => {
					calls.push(`executor:${context.traceId}`)
					return next()
				}),
			],
			handler: async (ctx: Ctx, name: string) => {
				calls.push(`handler:${ctx.traceId}:${name}`)
				return `${name}-done`
			},
		})
		expect(await read({ userId: 'u_1' }, 'summary')).toBe('summary-done')
		expect(calls).toEqual([
			'execute:before',
			'kernel:reports',
			'executor:t_9',
			'handler:t_9:summary',
			'execute:after',
		])
	})

	it('calling next() twice throws', async () => {
		const Query = queryHarness()
		const queries = new Query<{ userId: string }, object>({
			defaults: {},
			middleware: [
				Query.middleware(async ({ next }) => {
					await next()
					return next()
				}),
			],
			execute: (execution) => execution.run(),
		})
		const read = queries.exec({ handler: async () => 'x' })
		await expect(read({ userId: 'u_1' })).rejects.toThrow(/more than once/)
	})
	it('retains variadic handlers, metadata overrides and repeatable policy execution', async () => {
		const Query = queryHarness()
		const seen: string[] = []
		const queries = new Query<{ actorId: string }, { surface: string }>({
			defaults: { surface: 'default' },
			execute: async (execution) => {
				seen.push(`${execution.context.actorId}:${execution.metadata.surface}`)
				return execution.run()
			},
		})
		const read = queries.exec({
			metadata: { surface: 'reports' },
			handler: (context, title: string, count: number) => `${context.actorId}:${title}:${count}`,
		})
		expect(await read({ actorId: 'a' }, 'first', 1)).toBe('a:first:1')
		expect(await read({ actorId: 'b' }, 'second', 2)).toBe('b:second:2')
		expect(seen).toEqual(['a:reports', 'b:reports'])
	})
})
