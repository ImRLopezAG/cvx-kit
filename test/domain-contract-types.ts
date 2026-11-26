import { k } from '../src/k'
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
			input: k.string().transform((text) => text.length),
			result: k.number().transform((count) => ({ count })),
			classification: 'business',
			replayResult: k.object({ count: k.number() }),
		},
	},
	queries: { get: { input: k.number(), result: k.string() } },
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
		bad: { input: k.string(), result: k.string() },
	},
})
defineDomainContract({
	queries: {
		// @ts-expect-error queries cannot declare replay outputs
		bad: { input: k.string(), result: k.string(), replayResult: k.string() },
	},
})
defineDomainContract({
	commands: {
		bad: {
			input: k.string(),
			result: k.number(),
			classification: 'business',
			// @ts-expect-error replay must decode the final result type
			replayResult: k.string(),
		},
	},
})

const wireEntry = operationContract({
	input: k.string(),
	result: k.number().transform((count) => ({ count })),
	classification: 'business',
	replayResult: k.object({ count: k.number() }),
	wire: { schema: k.string(), project: (value) => String(value.count) },
})
const wire = defineDomainContract({ commands: { save: wireEntry } })
void wire

const lazyDomain = defineDomainContract(() => ({
	commands: { create: { input: k.string(), result: k.number(), classification: 'business' } },
	queries: { get: { input: k.number(), result: k.string() } },
}))
const lazyAssertions: [
	Assert<Equal<keyof typeof lazyDomain.commands, 'create'>>,
	Assert<Equal<typeof lazyDomain.commands.create.classification, 'business'>>,
	Assert<Equal<ContractInput<typeof lazyDomain.queries.get.input>, number>>,
] = [true, true, true]
void lazyAssertions
// @ts-expect-error thunks retain forbidden implementation-field checks
defineDomainContract(() => ({
	queries: { bad: { input: k.string(), result: k.string(), handler: () => '' } },
}))
// @ts-expect-error thunks retain replay-result compatibility checks
defineDomainContract(() => ({
	commands: {
		bad: {
			input: k.string(),
			result: k.number(),
			classification: 'business',
			replayResult: k.string(),
		},
	},
}))
// @ts-expect-error thunk command classification is still required
defineDomainContract(() => ({ commands: { bad: { input: k.string(), result: k.string() } } }))

const getterDomain = defineDomainContract(() => ({
	commands: {
		get create() {
			return {
				input: k.string().transform((text) => text.length),
				result: k.number(),
				classification: 'business',
			}
		},
	},
	queries: {
		get: {
			get input() {
				return k.number()
			},
			result: k.string(),
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
			return { input: k.string(), result: k.string() }
		},
	},
})
defineDomainContract({
	queries: {
		// @ts-expect-error getter-declared operations keep forbidden implementation-field checks
		get bad() {
			return { input: k.string(), result: k.string(), handler: () => '' }
		},
	},
})
