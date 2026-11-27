import { Context, Effect } from 'effect'
import { k } from '../src/k'
import type { StandardSchema } from '../src/contracts'
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
			input: k.number(),
			result: k.number(),
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
			input: k.number(),
			result: k.number(),
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
		invalid: { input: k.string(), result: k.number(), handler: (input: number) => input },
	}),
})
foundation.Command({
	context: (host: {}) => host,
	operations: () => ({
		// @ts-expect-error unchecked manual command entries must not bypass their contracts
		invalid: {
			input: k.string(),
			result: k.number(),
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
			input: k.number(),
			result: k.number(),
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
			input: k.number(),
			result: k.number(),
			handler: (input, context) => input + context.secret.length,
		}),
	}),
})
const plain = effectOperationFactory<{}>()
const checkedQuery = plain.query({
	input: k.string(),
	result: k.number(),
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
	operations: () => ({ read: { ...checkedQuery, input: k.number() } }),
})
const checkedCommand = plain.command({
	input: k.string(),
	result: k.number(),
	classification: 'business',
	audit: () => null,
	handler: (input) => input.length,
})
// k has no async transforms: asynchronous Standard Schemas stand in for them.
const asyncInput: StandardSchema<string, number> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate: async (value) => ({ value: String(value).length }),
	},
}
const asyncResult: StandardSchema<number, string> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate: async (value) => ({ value: String(value) }),
	},
}
const asyncChecked = plain.query({
	input: asyncInput,
	result: asyncResult,
	handler: (input) => input + 1,
})
const asyncAssertions: [Assert<Equal<Parameters<typeof asyncChecked.handler>[0], number>>] = [true]
void asyncAssertions
foundation.Command({
	context: (host: {}) => host,
	// @ts-expect-error command entries likewise reject stale evidence after a handler replacement
	operations: () => ({ save: { ...checkedCommand, handler: (input: number) => input } }),
})
