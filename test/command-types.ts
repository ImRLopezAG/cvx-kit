import { z } from 'zod'
import {
	Foundation,
	type AnyCommandMiddleware,
} from '../src/components/foundation/client'

const legacyMiddleware: AnyCommandMiddleware = async ({
	operation,
	command,
	next,
}) => {
	operation.toUpperCase()
	const boundary: unknown = command
	void boundary
	return next()
}
void legacyMiddleware

const { Command } = new Foundation(
	{ functions: { status: null } },
	{
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'ERROR' }),
		},
	},
)
const typed = Command.withContext<{ actorId: string }>()
const legacyOperation = Command.operation({
	command: z.object({}),
	result: z.number(),
	classification: 'business',
	audit: () => null,
	middleware: [
		async ({ operation, next }) => {
			operation.toUpperCase()
			return next()
		},
	],
})
new Command(
	{ legacyOperation },
	{
		middleware: [
			async ({ operation, next }) => {
				operation.toUpperCase()
				return next()
			},
		],
	},
)
const operations = {
	rename: typed.operation({
		command: z.object({
			title: z.string().transform((value) => value.length),
		}),
		result: z.object({ ok: z.boolean() }),
		classification: 'business',
		aggregates: ['document'],
		guard: (context, command) => {
			context.actorId.toUpperCase()
			command.title.toFixed()
			// @ts-expect-error parsed title is a number
			command.title.toUpperCase()
		},
		middleware: [
			async ({ command, context, next }) => {
				command.title.toFixed()
				context.actorId.toUpperCase()
				const result = await next()
				result.ok.valueOf()
				// @ts-expect-error result has no count
				void result.count
				return result
			},
		],
		audit: ({ command, result }, context) => ({
			operation: 'rename',
			actorId: context.actorId,
			aggregate: {
				type: 'document',
				id: String(command.title + Number(result.ok)),
			},
		}),
	}),
	count: typed.operation({
		command: z.object({ count: z.number().default(0) }),
		result: z.number(),
		classification: 'business',
		audit: ({ command, result }) => {
			command.count.toFixed()
			result.toFixed()
			return null
		},
	}),
}
const commands = new Command<{ actorId: string }, typeof operations>(
	operations,
)
// @ts-expect-error operation callbacks require the declared host context
new Command<{ wrong: string }, typeof operations>(operations)
const rename = commands.exec({
	operation: 'rename',
	handler: (_context, command) => ({ ok: command.title > 0 }),
})
void rename({ actorId: 'actor' }, { title: 'raw input' })
// @ts-expect-error callers supply schema inputs, not transformed outputs
void rename({ actorId: 'actor' }, { title: 3 })
// @ts-expect-error operation name stays narrow
commands.exec({ operation: 'missing', handler: () => 1 })
// @ts-expect-error handler result must match the schema
commands.exec({ operation: 'count', handler: () => 'wrong' })
typed.operation({
	command: z.object({}),
	result: z.number(),
	classification: 'business',
	aggregates: ['document'],
	audit: () => ({
		operation: 'invalid',
		actorId: 'actor',
		// @ts-expect-error aggregate must belong to the declared vocabulary
		aggregate: { type: 'wrong', id: '1' },
	}),
})
const registryMiddleware = typed.registryMiddleware(
	operations,
	async (input) => {
		if (input.operation === 'rename') {
			input.command.title.toFixed()
			const result = await input.next()
			result.ok.valueOf()
			return result
		}
		input.command.count.toFixed()
		return input.next()
	},
)
// @ts-expect-error registry callbacks must use a compatible host context
Command.withContext<{ wrong: string }>().registryMiddleware(operations, async input => input.next())
new Command<{ actorId: string }, typeof operations>(operations, {
	middleware: [registryMiddleware],
})
const enriched = Command.withContext<
	{ actorId: string },
	{ traceId: string }
>()
const enrichedOperations = {
	touch: enriched.operation({
		command: z.object({}),
		result: z.string(),
		classification: 'business',
		middleware: [
			async ({ next }) => next({ context: { traceId: 'trace' } }),
		],
		guard: (context) => {
			context.traceId.toUpperCase()
		},
		audit: () => null,
	}),
}
new Command<{ actorId: string }, typeof enrichedOperations>(
	enrichedOperations,
).exec({
	operation: 'touch',
	handler: (context) => context.traceId.toUpperCase(),
})
enriched.operation({
	command: z.object({}),
	result: z.string(),
	classification: 'business',
	audit: () => null,
	middleware: [
		async ({ next }) => {
			// @ts-expect-error the first layer must supply the declared extension
			return next()
		},
	],
})
