import { Context, Effect } from 'effect'
import { z } from 'zod'
import { createEffectFoundation, effectOperationFactory } from '../src/effect'

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value
class DefaultService extends Context.Service<DefaultService, number>()('ReviewDefaultService') {}
class DefaultFailure {
	readonly _tag = 'DefaultFailure'
}
const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'ERROR' }),
	},
	writeAudit: () => undefined,
})
const external = effectOperationFactory<{ actorId: string }, { traceId: string }>()
const guard = () => DefaultService.pipe(Effect.andThen(Effect.fail(new DefaultFailure())))
const queries = foundation.Query({
	context: (host: { actorId: string }) => host,
	defaults: { guard },
	operations: () => ({
		read: external.query({
			input: z.number(),
			result: z.number(),
			handler: (input, context) => input + context.traceId.length,
			middleware: ({ next }) => next({ context: { traceId: 'trace' } }),
		}),
	}),
})
const commands = foundation.Command({
	context: (host: { actorId: string }) => host,
	defaults: { guard },
	operations: () => ({
		save: external.command({
			input: z.number(),
			result: z.number(),
			classification: 'business',
			audit: () => null,
			handler: (input, context) => input + context.traceId.length,
			middleware: ({ next }) => next({ context: { traceId: 'trace' } }),
		}),
	}),
})
const read = queries.exec('read', 1, { actorId: 'actor' })
const save = commands.exec('save', 1, { actorId: 'actor' })
const assertions: [
	Assert<Equal<Effect.Error<typeof read>, DefaultFailure>>,
	Assert<Equal<Effect.Services<typeof read>, DefaultService>>,
	Assert<Equal<Effect.Error<typeof save>, DefaultFailure>>,
	Assert<Equal<Effect.Services<typeof save>, DefaultService>>,
] = [true, true, true, true]
void assertions
// @ts-expect-error a standalone helper cannot hide the registry's required guard service
void Effect.runPromise(read)
// @ts-expect-error commands likewise retain the required default guard service
void Effect.runPromise(save)
foundation.Query({
	context: (host: {}) => host,
	operations: () => ({
		// @ts-expect-error unchecked manual entries must not bypass parsed input/result contracts
		invalid: { input: z.string(), result: z.number(), handler: (input: number) => input },
	}),
})
foundation.Command({
	context: (host: {}) => host,
	operations: () => ({
		// @ts-expect-error unchecked manual command entries must not bypass their contracts
		invalid: {
			input: z.string(),
			result: z.number(),
			classification: 'business',
			audit: () => null,
			handler: (input: number) => input,
		},
	}),
})
const optionalPermission: ((host: { tenantId: string }) => void) | undefined =
	Math.random() > 0.5
		? (host) => {
				void host.tenantId
			}
		: undefined
const optionalFoundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'ERROR' }),
	},
	checkPermission: optionalPermission,
	writeAudit: () => undefined,
})
optionalFoundation.Command({
	// @ts-expect-error an optional configured checker still constrains trusted host context
	context: (host: { actorId: string }) => host,
	operations: ({ command }) => ({
		save: command({
			input: z.number(),
			result: z.number(),
			classification: 'business',
			audit: () => null,
			handler: (input) => input,
		}),
	}),
})
const wrongContext = effectOperationFactory<{ secret: string }>()
foundation.Query({
	context: (host: { actorId: string }) => host,
	operations: () => ({
		// @ts-expect-error a standalone helper must check the actual resolved base context
		read: wrongContext.query({
			input: z.number(),
			result: z.number(),
			handler: (input, context) => input + context.secret.length,
		}),
	}),
})
const plain = effectOperationFactory<{}>()
const checkedQuery = plain.query({
	input: z.string(),
	result: z.number(),
	handler: (input) => input.length,
})
foundation.Query({
	context: (host: {}) => host,
	// @ts-expect-error spreading a checked entry cannot replace its handler with an incompatible signature
	operations: () => ({ read: { ...checkedQuery, handler: (input: number) => input } }),
})
foundation.Query({
	context: (host: {}) => host,
	// @ts-expect-error a replaced input schema must agree with the checked handler
	operations: () => ({ read: { ...checkedQuery, input: z.number() } }),
})
const checkedCommand = plain.command({
	input: z.string(),
	result: z.number(),
	classification: 'business',
	audit: () => null,
	handler: (input) => input.length,
})
foundation.Command({
	context: (host: {}) => host,
	// @ts-expect-error command entries likewise reject stale evidence after a handler replacement
	operations: () => ({ save: { ...checkedCommand, handler: (input: number) => input } }),
})
