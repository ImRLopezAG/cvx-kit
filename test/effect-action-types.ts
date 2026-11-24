import type { Effect } from 'effect'
import { z } from 'zod'
import { createEffectFoundation, type ContractValidationError } from '../src/effect'

const foundation = createEffectFoundation({
	observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'F' }) },
	writeAudit: (_host: { db: true }) => undefined,
	writeActionAudit: (_host: { runMutation: true }) => undefined,
})
const actions = foundation.Action({
	context: (host: { runMutation: true }) => host,
	operations: ({ action }) => ({
		// Classification and audit are optional for actions.
		ping: action({ input: z.string(), result: z.number(), handler: (input) => input.length }),
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
			input: z.string(),
			result: z.string(),
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
			input: z.string(),
			result: z.string(),
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
		ping: action({ input: z.string(), result: z.string(), handler: (input) => input }),
	}),
})
