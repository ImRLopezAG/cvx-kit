import { Context, Effect } from 'effect'
import { z } from 'zod'
import { defineDomainContract } from '../src/contracts'
import { ContractValidationError } from '../src/modules/effect/schema'
import { createEffectFoundation } from '../src/effect'
const domain = defineDomainContract({
	commands: {
		save: {
			input: z.string().transform(Number),
			result: z.number().transform((n) => ({ n })),
			classification: 'business',
		},
		close: { input: z.number(), result: z.boolean(), classification: 'business' },
	},
	queries: { get: { input: z.string(), result: z.number() } },
})
const { Command, Query } = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAIL' }),
	},
	writeAudit: (_host: { actor: string }) => undefined,
})
class Service extends Context.Service<Service, { value: number }>()('DomainService') {}
const commands = Command({
	contract: domain,
	context: (host: { actor: string }) => host,
	audit: (resolution, context) => {
		if (resolution.operation === 'save') {
			const input: number = resolution.input
			const result: { n: number } = resolution.result
			void input
			void result
		}
		return Effect.flatMap(Service, () =>
			Effect.sync(() => {
				void context.actor
				return null
			}),
		)
	},
	operations: ({ command }) => ({
		save: command.save({
			handler: (input, context) => {
				const n: number = input
				void context.actor
				return Effect.succeed(n)
			},
		}),
		close: command.close({ handler: () => true, audit: () => null }),
	}),
})
const result: Effect.Effect<{ n: number }, ContractValidationError, Service> = commands.exec(
	'save',
	'2',
	{ actor: 'a' },
)
const overridden: Effect.Effect<boolean, ContractValidationError, never> = commands.exec(
	'close',
	2,
	{ actor: 'a' },
)
void result
void overridden
Command({
	contract: domain,
	context: (host: { actor: string }) => host,
	audit: () => null,
	// @ts-expect-error missing operation
	operations: ({ command }) => ({ save: command.save({ handler: (n) => n }) }),
})
Command({
	contract: domain,
	context: (host: { actor: string }) => host,
	audit: () => null,
	// @ts-expect-error undeclared operation via variable
	operations: ({ command }) => {
		const operations = {
			save: command.save({ handler: (n) => n }),
			close: command.close({ handler: () => true }),
			extra: command.close({ handler: () => true }),
		}
		return operations
	},
})
Command({
	contract: domain,
	context: (host: { actor: string }) => host,
	audit: () => null,
	// @ts-expect-error mismatched helper key
	operations: ({ command }) => ({
		save: command.close({ handler: () => true, audit: () => null }),
		close: command.close({ handler: () => true, audit: () => null }),
	}),
})
Command({
	contract: domain,
	context: (host: { actor: string }) => host,
	operations: ({ command }) => ({
		// @ts-expect-error no audit source
		save: command.save({ handler: (n) => n }),
		// @ts-expect-error no audit source
		close: command.close({ handler: () => true }),
	}),
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
Query({
	contract: domain,
	context: (host: { actor: string }) => host,
	operations: ({ query }) => ({
		get: query.get({
			// @ts-expect-error invalid output
			handler: () => 'wrong',
		}),
	}),
})
const inline = Command({
	context: (host: { actor: string }) => host,
	audit: () => Effect.flatMap(Service, () => Effect.succeed(null)),
	operations: ({ command }) => ({
		save: command({
			input: z.string().transform(Number),
			result: z.number(),
			classification: 'business',
			handler: (input) => input,
		}),
	}),
})
const inlineResult: Effect.Effect<number, never, Service> = inline.exec('save', '2', { actor: 'a' })
void inlineResult
class AuditService extends Context.Service<AuditService, { value: boolean }>()('AuditService') {}
class AuditFailure {
	readonly _tag = 'AuditFailure'
}
class RootFailure {
	readonly _tag = 'RootFailure'
}
const conditionalAudit =
	Math.random() > 0.5
		? () => Effect.flatMap(AuditService, () => Effect.fail(new AuditFailure()))
		: undefined
const optional = Command({
	contract: domain,
	context: (host: { actor: string }) => host,
	audit: () => Effect.flatMap(Service, () => Effect.fail(new RootFailure())),
	operations: ({ command }) => ({
		save: command.save({ handler: (n) => n, audit: conditionalAudit }),
		close: command.close({ handler: () => true, audit: () => null }),
	}),
})
const conditional: Effect.Effect<
	{ n: number },
	AuditFailure | RootFailure,
	Service | AuditService
> = optional.exec('save', '2', { actor: 'a' })
void conditional
// @ts-expect-error an optional override cannot erase default or override services
const missingServices: Effect.Effect<{ n: number }, AuditFailure | RootFailure, never> =
	optional.exec('save', '2', { actor: 'a' })
void missingServices
