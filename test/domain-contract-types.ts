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

const lazyDomain = defineDomainContract(() => ({
	commands: { create: { input: z.string(), result: z.number(), classification: 'business' } },
	queries: { get: { input: z.number(), result: z.string() } },
}))
const lazyAssertions: [
	Assert<Equal<keyof typeof lazyDomain.commands, 'create'>>,
	Assert<Equal<typeof lazyDomain.commands.create.classification, 'business'>>,
	Assert<Equal<ContractInput<typeof lazyDomain.queries.get.input>, number>>,
] = [true, true, true]
void lazyAssertions
// @ts-expect-error thunks retain forbidden implementation-field checks
defineDomainContract(() => ({
	queries: { bad: { input: z.string(), result: z.string(), handler: () => '' } },
}))
// @ts-expect-error thunks retain replay-result compatibility checks
defineDomainContract(() => ({
	commands: {
		bad: {
			input: z.string(),
			result: z.number(),
			classification: 'business',
			replayResult: z.string(),
		},
	},
}))
// @ts-expect-error thunk command classification is still required
defineDomainContract(() => ({ commands: { bad: { input: z.string(), result: z.string() } } }))

const getterDomain = defineDomainContract(() => ({
	commands: {
		get create() {
			return {
				input: z.string().transform((text) => text.length),
				result: z.number(),
				classification: 'business',
			}
		},
	},
	queries: {
		get: {
			get input() {
				return z.number()
			},
			result: z.string(),
		},
	},
}))
const getterAssertions: [
	Assert<Equal<keyof typeof getterDomain.commands, 'create'>>,
	Assert<Equal<ContractInput<typeof getterDomain.commands.create.input>, string>>,
	Assert<Equal<ContractOutput<typeof getterDomain.commands.create.input>, number>>,
	Assert<Equal<ContractInput<typeof getterDomain.queries.get.input>, number>>,
] = [true, true, true, true]
void getterAssertions
defineDomainContract({
	commands: {
		// @ts-expect-error getter-declared commands still require a classification
		get bad() {
			return { input: z.string(), result: z.string() }
		},
	},
})
defineDomainContract({
	queries: {
		// @ts-expect-error getter-declared operations keep forbidden implementation-field checks
		get bad() {
			return { input: z.string(), result: z.string(), handler: () => '' }
		},
	},
})
