import { z } from 'zod'
import {
	defineDomainContract,
	operationContract,
	type ContractInput,
	type ContractOutput,
} from '../src/contracts'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
const domain = defineDomainContract({
	commands: {
		create: {
			input: z.string().transform((text) => text.length),
			result: z.number().transform((count) => ({ count })),
			classification: 'business',
			replayResult: z.object({ count: z.number() }),
		},
	},
	queries: { get: { input: z.number(), result: z.string() } },
})
const assertions: [
	Assert<Equal<keyof typeof domain.commands, 'create'>>,
	Assert<Equal<ContractInput<typeof domain.commands.create.input>, string>>,
	Assert<Equal<ContractOutput<typeof domain.commands.create.input>, number>>,
] = [true, true, true]
void assertions
defineDomainContract({
	commands: {
		// @ts-expect-error command classification is required
		bad: { input: z.string(), result: z.string() },
	},
})
defineDomainContract({
	queries: {
		// @ts-expect-error queries cannot declare replay outputs
		bad: { input: z.string(), result: z.string(), replayResult: z.string() },
	},
})
defineDomainContract({
	commands: {
		bad: {
			input: z.string(),
			result: z.number(),
			classification: 'business',
			// @ts-expect-error replay must decode the final result type
			replayResult: z.string(),
		},
	},
})

const wireEntry = operationContract({
	input: z.string(),
	result: z.number().transform((count) => ({ count })),
	classification: 'business',
	replayResult: z.object({ count: z.number() }),
	wire: { schema: z.string(), project: (value) => String(value.count) },
})
const wire = defineDomainContract({ commands: { save: wireEntry } })
void wire
