import { z } from 'zod'
import { createFoundation } from '../src/index'
import { createEffectFoundation } from '../src/effect'
import { defineDomainContract } from '../src/contracts'
const contract = defineDomainContract({
	queries: {
		first: { input: z.string(), result: z.string() },
		second: { input: z.string(), result: z.string() },
	},
})
const options = {
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed' as const, errorCode: 'FAIL' }),
	},
	writeAudit: () => undefined,
}
createEffectFoundation(options).Query({
	contract,
	context: () => ({}),
	// @ts-expect-error helper keys must match even when schema types are identical
	operations: ({ query }) => ({
		first: query.second({ handler: (input) => input }),
		second: query.first({ handler: (input) => input }),
	}),
})
createFoundation(options).Query({
	// @ts-expect-error helper keys must match even when schema types are identical
	contract,
	context: () => ({}),
	// @ts-expect-error the wrong-key operation map cannot match the inline fallback
	operations: ({ query }) => ({
		first: query.second({ handler: (input) => input }),
		second: query.first({ handler: (input) => input }),
	}),
})
// SAFETY: deliberately widened declaration models a caller that erased its key set; the registry must reject it.
const widened = { queries: {} as Record<string, typeof contract.queries.first> }
createEffectFoundation(options).Query({
	// @ts-expect-error a string index cannot prove the declared operation set
	contract: widened,
	context: () => ({}),
	operations: () => ({}),
})
createFoundation(options).Query({
	// @ts-expect-error a string index cannot prove the declared operation set
	contract: widened,
	context: () => ({}),
	operations: () => ({}),
})
const commands = defineDomainContract({
	commands: { save: { input: z.string(), result: z.string(), classification: 'business' } },
})
const maybeAudit = Math.random() > 0.5 ? () => null : undefined
createEffectFoundation(options).Command({
	// @ts-expect-error an optional audit cannot supply a definite audit source
	contract: commands,
	context: () => ({}),
	audit: maybeAudit,
	// @ts-expect-error an absent definite default leaves the operation audit mandatory
	operations: ({ command }) => ({ save: command.save({ handler: (input) => input }) }),
})
createFoundation(options).Command({
	// @ts-expect-error an optional audit cannot supply a definite audit source
	contract: commands,
	context: () => ({}),
	audit: maybeAudit,
	// @ts-expect-error an absent definite default leaves the operation audit mandatory
	operations: ({ command }) => ({ save: command.save({ handler: (input) => input }) }),
})
