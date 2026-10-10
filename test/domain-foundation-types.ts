import { z } from 'zod'
import { defineDomainContract } from '../src/contracts'
import { createFoundation } from '../src/index'
const domain = defineDomainContract({
	commands: {
		save: {
			input: z.string().transform(Number),
			result: z.number().transform((n) => ({ n })),
			classification: 'business',
		},
	},
	queries: { get: { input: z.string(), result: z.number() } },
})
const { Command, Query } = createFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAIL' }),
	},
	writeAudit: (_host: { actor: string }) => undefined,
})
const commands = Command({
	contract: domain,
	context: async (host: { actor: string }) => host,
	audit: (resolution, context) => {
		const n: number = resolution.input
		const result: { n: number } = resolution.result
		void n
		void result
		void context.actor
		return null
	},
	operations: ({ command }) => ({
		save: command.save({
			handler: (input, context) => {
				void context.actor
				return input + 1
			},
		}),
	}),
})
const result: Promise<{ n: number }> = commands.exec('save', '2', { actor: 'a' })
void result
// @ts-expect-error raw input must match the contract
commands.exec('save', 2, { actor: 'a' })
Command({
	// @ts-expect-error invalid contracted implementation is rejected by every overload
	contract: domain,
	context: (host: { actor: string }) => host,
	operations: ({ command }) => ({
		// @ts-expect-error contracted command requires an audit when the registry has no default
		save: command.save({ handler: (n) => n }),
	}),
})
Command({
	// @ts-expect-error missing operation
	contract: domain,
	context: (host: { actor: string }) => host,
	audit: () => null,
	operations: () => ({}),
})
Command({
	// @ts-expect-error invalid contracted implementation is rejected by every overload
	contract: domain,
	context: (host: { actor: string }) => host,
	audit: () => null,
	// @ts-expect-error undeclared operation via variable
	operations: ({ command }) => {
		const operations = {
			save: command.save({ handler: (n) => n }),
			extra: command.save({ handler: (n) => n }),
		}
		return operations
	},
})
Query({
	contract: domain,
	context: (host: { actor: string }) => host,
	operations: ({ query }) => ({
		get: query.get({
			// @ts-expect-error protected schema
			input: z.string(),
			// @ts-expect-error schemas cannot be replaced in a contracted helper
			handler: () => 2,
		}),
	}),
})
const inline = Command({
	context: (host: { actor: string }) => host,
	audit: () => null,
	operations: ({ command }) => ({
		save: command({
			input: z.string().transform(Number),
			result: z.number(),
			classification: 'business',
			handler: (input, context) => {
				void context.actor
				return input
			},
		}),
	}),
})
const inlineResult: Promise<number> = inline.exec('save', '2', { actor: 'a' })
void inlineResult
