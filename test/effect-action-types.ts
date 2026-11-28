import type { Effect } from 'effect'
import { k } from '../src/k'
import { createEffectFoundation, type ContractValidationError } from '../src/effect'
import { defineDomainContract } from '../src/modules/contracts/domain'

const foundation = createEffectFoundation({
	observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'F' }) },
	writeAudit: (_host: { db: true }) => undefined,
	writeActionAudit: (_host: { runMutation: true }) => undefined,
})
const actions = foundation.Action({
	context: (host: { runMutation: true }) => host,
	operations: ({ action }) => ({
		// Classification and audit are optional for actions.
		ping: action({ input: k.string(), result: k.number(), handler: (input) => input.length }),
	}),
})
const ran: Effect.Effect<number, ContractValidationError, never> = actions.exec('ping', 'x', {
	runMutation: true,
})
void ran
// @ts-expect-error Inputs keep their schema type.
actions.exec('ping', 1, { runMutation: true })
// @ts-expect-error Actions are never exposed as mutations.
void actions.expose
foundation.Action({
	context: (host: { runMutation: true }) => host,
	operations: ({ action }) => ({
		replay: action({
			input: k.string(),
			result: k.string(),
			handler: (input) => input,
			// @ts-expect-error Actions have no transaction to replay.
			prepare: () => ({ kind: 'execute' as const }),
		}),
	}),
})
foundation.Action({
	context: (host: { runMutation: true }) => host,
	operations: ({ action }) => ({
		guarded: action({
			input: k.string(),
			result: k.string(),
			handler: (input) => input,
			// @ts-expect-error Guards authorize actions; there is no permission host.
			permission: 'settle',
		}),
	}),
})
foundation.Action({
	// @ts-expect-error The action context host must satisfy the action audit writer's host.
	context: (host: { db: true }) => host,
	operations: ({ action }) => ({
		ping: action({ input: k.string(), result: k.string(), handler: (input) => input }),
	}),
})

const contract = defineDomainContract({
	actions: {
		'provider.send': { input: k.string(), result: k.boolean() },
		'provider.poll': { input: k.string(), result: k.string() },
	},
})
const contracted = foundation.Action({
	contract,
	context: (host: { runMutation: true }) => host,
	operations: ({ action }) => ({
		'provider.send': action.handler((input) => input.length > 0),
		'provider.poll': action['provider.poll']({ handler: (input) => input }),
	}),
})
const sent: Effect.Effect<boolean, ContractValidationError, never> = contracted.exec(
	'provider.send',
	'x',
	{ runMutation: true },
)
void sent
foundation.Action({
	contract,
	context: (host: { runMutation: true }) => host,
	// @ts-expect-error Every declared action must be implemented.
	operations: ({ action }) => ({ 'provider.send': action.handler(() => true) }),
})
defineDomainContract({
	actions: {
		// @ts-expect-error Contracts declare schemas only; implementations live in registries.
		'provider.send': { input: k.string(), result: k.boolean(), handler: () => true },
	},
})
