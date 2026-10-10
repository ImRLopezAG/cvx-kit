import { z } from 'zod'
import { createFoundation } from '../src/index'
import { defineDomainContract } from '../src/contracts'
import { defineErrorContract } from '../src/errors'

const contract = defineDomainContract({
	errors: defineErrorContract({ Missing: { message: 'Task missing', details: {} } }),
	commands: {
		'tasks.create': {
			input: z.string().transform(Number),
			result: z.number().transform((count) => ({ count })),
			classification: 'business',
		},
		'tasks.close': {
			input: z.object({ id: z.string() }),
			result: z.boolean(),
			classification: 'business',
		},
	},
	queries: { 'tasks.get': { input: z.number(), result: z.number() } },
})
const { Command, Query } = createFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
	},
	writeAudit: (_host: { actorId: string }, entry) => {
		console.log(entry.operation)
	},
})
const commands = Command({
	contract,
	context: (host: { actorId: string }) => host,
	audit: ({ operation, input, result }, context) => {
		if (operation !== 'tasks.create') return null
		return {
			operation,
			actorId: context.actorId,
			aggregate: { type: 'task', id: String(input) },
			metadata: { count: result.count },
		}
	},
	operations: ({ command }) => ({
		'tasks.create': command['tasks.create']({ handler: (input) => input + 1 }),
		'tasks.close': command['tasks.close']({
			handler: (input) => input.id.length > 0,
			audit: () => null,
		}),
	}),
})
const queries = Query({
	contract,
	context: (host: { actorId: string }) => host,
	operations: ({ query }) => ({ 'tasks.get': query['tasks.get']({ handler: (input) => input }) }),
})
const created = await commands.exec('tasks.create', '2', { actorId: 'actor' })
const count = await queries.withContext({ actorId: 'actor' }).exec('tasks.get', created.count)
void count
