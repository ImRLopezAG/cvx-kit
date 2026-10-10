import { Effect } from 'effect'
import { expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { defineDomainContract } from '../src/contracts'
import { createEffectFoundation } from '../src/effect'

it('binds contracted commands and queries without running callbacks at construction', async () => {
	const events: string[] = []
	const domain = defineDomainContract({
		commands: {
			save: {
				input: z.string().transform(Number),
				result: z.number().transform((n) => ({ n })),
				classification: 'business',
			},
		},
		queries: { get: { input: z.number(), result: z.number() } },
	})
	const { Command, Query } = createEffectFoundation({
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAIL' }),
		},
		writeAudit: (_host: { actor: string }) => {
			events.push('write')
		},
	})
	const commands = Command({
		contract: domain,
		context: (host: { actor: string }) => {
			events.push('context')
			return host
		},
		audit: ({ operation, input, result }, context) => {
			events.push(`${operation}:${input}:${result.n}:${context.actor}`)
			return null
		},
		operations: ({ command }) => ({
			save: command.save({
				handler: (input, context) => {
					events.push(context.actor)
					return Effect.succeed(input + 1)
				},
			}),
		}),
	})
	const queries = Query({
		contract: domain,
		context: (host: { actor: string }) => host,
		operations: ({ query }) => ({
			get: query.get({
				handler: (input, context) => {
					events.push(context.actor)
					return input
				},
			}),
		}),
	})
	expect(events).toEqual([])
	expect(await Effect.runPromise(commands.exec('save', '2', { actor: 'a' }))).toEqual({ n: 3 })
	expect(events).toEqual(['context', 'a', 'save:2:3:a'])
	expect(await Effect.runPromise(queries.exec('get', 4, { actor: 'a' }))).toBe(4)
})
