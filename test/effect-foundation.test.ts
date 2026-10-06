import { Context, Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { createEffectFoundation } from '../src/effect'

class Documents extends Context.Service<Documents, { title: string }>()('Documents') {}

describe('Effect Foundation composition', () => {
	it('composes a query inside a command under shared host policies and one runner', async () => {
		const events: string[] = []
		const foundation = createEffectFoundation({
			observability: {
				enabled: true,
				classifyError: () => ({ outcome: 'failed' as const, errorCode: 'FAILED' }),
				emit: (entry) => {
					events.push(`${entry.operation}:${entry.outcome}`)
				},
			},
			checkPermission: (host: { actorId: string }, { permission }: { permission: string }) => {
				events.push(`${host.actorId}:${permission}`)
			},
			writeAudit: (host: { actorId: string }) => {
				events.push(`${host.actorId}:audit`)
			},
		})
		const queries = foundation.Query({
			context: (host: { actorId: string }) => host,
			operations: ({ query }) => ({
				title: query({
					input: z.object({}),
					result: z.string(),
					permission: 'read',
					handler: () =>
						Effect.gen(function* () {
							return (yield* Documents).title
						}),
				}),
			}),
		})
		const commands = foundation.Command({
			context: (host: { actorId: string }) => host,
			operations: ({ command }) => ({
				rename: command({
					input: z.object({ suffix: z.string() }),
					result: z.string(),
					classification: 'business',
					permission: 'write',
					handler: (input, host) =>
						Effect.gen(function* () {
							return (yield* queries.exec('title', {}, host)) + input.suffix
						}),
					audit: (_resolution, host) => ({
						operation: 'rename',
						actorId: host.actorId,
						aggregate: { type: 'document', id: 'fixture' },
					}),
				}),
			}),
		})
		const execution = commands.exec('rename', { suffix: '!' }, { actorId: 'actor' })
		expect(events).toEqual([])
		expect(
			await Effect.runPromise(execution.pipe(Effect.provideService(Documents, { title: 'draft' }))),
		).toBe('draft!')
		expect(events).toEqual([
			'actor:write',
			'actor:read',
			'title:completed',
			'actor:audit',
			'rename:completed',
		])
	})
})
