import { expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { defineDomainContract } from '../src/contracts'
import { createFoundation } from '../src/index'
it('runs regular contracted registries without Effect', async () => {
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
	const events: string[] = []
	const { Command, Query } = createFoundation({
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
		context: (host: { actor: string }) => host,
		audit: ({ operation, input, result }, context) => {
			events.push(`${operation}:${input}:${result.n}:${context.actor}`)
			return null
		},
		operations: ({ command }) => ({
			save: command.save({
				handler: async (input, context) => {
					events.push(context.actor)
					return input + 1
				},
			}),
		}),
	})
	const queries = Query({
		contract: domain,
		context: (host: { actor: string }) => host,
		operations: ({ query }) => ({ get: query.get({ handler: (input) => input }) }),
	})
	expect(events).toEqual([])
	expect(await commands.exec('save', '2', { actor: 'a' })).toEqual({ n: 3 })
	expect(events).toEqual(['a', 'save:2:3:a'])
	expect(await queries.exec('get', 4, { actor: 'a' })).toBe(4)
})
