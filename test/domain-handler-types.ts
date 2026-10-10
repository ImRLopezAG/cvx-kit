import { Context, Effect } from 'effect'
import { z } from 'zod'
import { defineDomainContract } from '../src/contracts'
import { createFoundation } from '../src/index'
import { createEffectFoundation } from '../src/effect'
import { ContractValidationError } from '../src/modules/effect/schema'

const contract = defineDomainContract({
	commands: {
		'notifications.markRead': {
			input: z.string().transform(Number),
			result: z.number().transform((n) => ({ n })),
			classification: 'business',
		},
		close: { input: z.object({ id: z.string() }), result: z.boolean(), classification: 'business' },
	},
	queries: {
		get: { input: z.number(), result: z.string() },
		handler: { input: z.boolean(), result: z.boolean() },
	},
})
const options = {
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed' as const, errorCode: 'FAIL' }),
	},
	writeAudit: (_host: { actor: string }) => undefined,
}
const context = (host: { actor: string }) => host
const normal = createFoundation(options)
const regular = normal.Command({
	contract,
	context,
	audit: () => null,
	operations: ({ command }) => ({
		'notifications.markRead': command.handler(
			(input, ctx) => {
				// @ts-expect-error inferred numbers do not expose object properties
				void input.missing
				const n: number = input
				const actor: string = ctx.actor
				void actor
				return n + 1
			},
			{
				guard: (ctx, input) => {
					const n: number = input
					void n
					void ctx.actor
				},
				audit: ({ command, result }, ctx) => {
					const n: number = command
					const decoded: { n: number } = result
					void n
					void decoded
					void ctx.actor
					return null
				},
			},
		),
		close: command.handler(async (input) => input.id.length > 0),
	}),
})
const regularResult: Promise<{ n: number }> = regular.exec('notifications.markRead', '2', {
	actor: 'a',
})
void regularResult
// @ts-expect-error execution uses the encoded contract input
regular.exec('notifications.markRead', 2, { actor: 'a' })
const queries = normal.Query({
	contract,
	context,
	operations: ({ query }) => ({
		get: query.handler((input) => String(input)),
		handler: query.handler((input) => !input),
	}),
})
const queryResult: Promise<string> = queries.exec('get', 2, { actor: 'a' })
void queryResult

class Service extends Context.Service<Service, { value: number }>()('HandlerService') {}
class Failure {
	readonly _tag = 'HandlerFailure'
}
const effect = createEffectFoundation(options)
const commands = effect.Command({
	contract,
	context,
	audit: () => null,
	operations: ({ command }) => ({
		'notifications.markRead': command.handler(
			(input, ctx) =>
				Effect.gen(function* () {
					// @ts-expect-error inferred numbers do not expose object properties
					void input.missing
					const n: number = input
					void ctx.actor
					const service = yield* Service
					if (n < 0) return yield* Effect.fail(new Failure())
					return n + service.value
				}),
			{
				guard: (ctx, input) => {
					const n: number = input
					void n
					void ctx.actor
				},
				audit: ({ command, result }, ctx) => {
					const n: number = command
					const decoded: { n: number } = result
					void n
					void decoded
					void ctx.actor
					return null
				},
			},
		),
		close: command.handler((input) => input.id.length > 0),
	}),
})
const effectResult: Effect.Effect<{ n: number }, Failure | ContractValidationError, Service> =
	commands.exec('notifications.markRead', '2', { actor: 'a' })
void effectResult
// @ts-expect-error handler services must remain required
const erased: Effect.Effect<{ n: number }, Failure | ContractValidationError, never> =
	commands.exec('notifications.markRead', '2', { actor: 'a' })
void erased
const effectQueries = effect.Query({
	contract,
	context,
	operations: ({ query }) => ({
		get: query.handler((input) => Effect.succeed(String(input))),
		handler: query.handler((input) => !input),
	}),
})
const effectQueryResult: Effect.Effect<string, ContractValidationError, never> = effectQueries.exec(
	'get',
	2,
	{ actor: 'a' },
)
void effectQueryResult

normal.Command({
	// @ts-expect-error an invalid implementation rejects the contracted registry
	contract,
	context,
	operations: ({ command }) => ({
		// @ts-expect-error a command must supply audit options without a registry audit
		'notifications.markRead': command.handler((input) => input),
		// @ts-expect-error invalid sibling prevents the contracted overload from matching
		close: command.handler((input) => input.id.length > 0, { audit: () => null }),
	}),
})
effect.Command({
	contract,
	context,
	operations: ({ command }) => ({
		// @ts-expect-error a command must supply audit options without a registry audit
		'notifications.markRead': command.handler((input) => input),
		// @ts-expect-error invalid sibling prevents the contracted overload from matching
		close: command.handler((input) => input.id.length > 0, { audit: () => null }),
	}),
})
normal.Query({
	contract,
	context,
	operations: ({ query }) => ({
		// @ts-expect-error schemas belong to the contract
		get: query.handler((input) => String(input), {
			input: z.number(),
		}),
		handler: query.handler((input) => !input),
	}),
})
effect.Query({
	contract,
	context,
	operations: ({ query }) => ({
		// @ts-expect-error queries cannot audit
		get: query.handler((input) => String(input), {
			audit: () => null,
		}),
		handler: query.handler((input) => !input),
	}),
})
normal.Query({
	// @ts-expect-error an invalid implementation rejects the contracted registry
	contract,
	context,
	operations: ({ query }) => ({
		// @ts-expect-error output must match this key's contract
		get: query.handler(() => false),
		// @ts-expect-error invalid sibling prevents the contracted overload from matching
		handler: query.handler((input) => !input),
	}),
})
effect.Query({
	contract,
	context,
	operations: ({ query }) => ({
		// @ts-expect-error output must match this key's contract
		get: query.handler(() => Effect.succeed(false)),
		// @ts-expect-error invalid sibling prevents the contracted overload from matching
		handler: query.handler((input) => !input),
	}),
})
normal.Query({
	// @ts-expect-error missing contract operation
	contract,
	context,
	// @ts-expect-error the incomplete map also cannot match an inline registry
	operations: ({ query }) => ({ get: query.handler((input) => String(input)) }),
})
effect.Query({
	contract,
	context,
	// @ts-expect-error missing contract operation
	operations: ({ query }) => ({ get: query.handler((input) => String(input)) }),
})

const auditEffectContract = defineDomainContract({
	commands: {
		save: { input: z.number(), result: z.number(), classification: 'business' },
	},
})
const audited = effect.Command({
	contract: auditEffectContract,
	context,
	operations: ({ command }) => ({
		save: command.handler((input) => input, { audit: () => Effect.map(Service, () => null) }),
	}),
})
const auditedResult: Effect.Effect<number, ContractValidationError, Service> = audited.exec(
	'save',
	1,
	{ actor: 'a' },
)
void auditedResult
// @ts-expect-error per-operation audit requirements must not be erased
const missingAuditService: Effect.Effect<number, ContractValidationError, never> = audited.exec(
	'save',
	1,
	{ actor: 'a' },
)
void missingAuditService

class AuditService extends Context.Service<AuditService, { value: boolean }>()(
	'HandlerAuditService',
) {}
class AuditFailure {
	readonly _tag = 'HandlerAuditFailure'
}
const override =
	Math.random() > 0.5
		? () => Effect.flatMap(AuditService, () => Effect.fail(new AuditFailure()))
		: undefined
const conditionalCommands = effect.Command({
	contract: auditEffectContract,
	context,
	audit: () => Effect.map(Service, () => null),
	operations: ({ command }) => ({ save: command.handler((input) => input, { audit: override }) }),
})
const conditionalResult: Effect.Effect<
	number,
	ContractValidationError | AuditFailure,
	Service | AuditService
> = conditionalCommands.exec('save', 1, { actor: 'a' })
void conditionalResult
// @ts-expect-error an optional override retains both audit service channels
const erasedAudits: Effect.Effect<number, ContractValidationError | AuditFailure, never> =
	conditionalCommands.exec('save', 1, { actor: 'a' })
void erasedAudits
