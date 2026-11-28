import { k } from '../src/k'
import { v, type GenericId } from 'convex/values'
import {
	convexContract,
	operationContract,
	standardContract,
	type ContractInput,
	type ContractOutput,
	type StandardSchema,
} from '../src/contracts'
import {
	effectOperationFactory,
	createEffectFoundation,
	type EffectOperationArgument,
	type EffectOperationInput,
	type EffectOperationHandlerResult,
	type EffectOperationResult,
} from '../src/effect'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
const asyncTrim: StandardSchema<string, string> = {
	'~standard': {
		version: 1,
		vendor: 'async',
		validate: async (value) => ({ value: String(value).trim() }),
	},
}
const asyncCount: StandardSchema<number, { count: number }> = {
	'~standard': {
		version: 1,
		vendor: 'async',
		validate: async (value) => ({ value: { count: Number(value) } }),
	},
}
const input = standardContract(asyncTrim)
const native = convexContract(v.object({ id: v.id('documents'), title: v.optional(v.string()) }))
const result = standardContract(asyncCount)
const contract = operationContract({
	input,
	result,
	replayResult: k.object({ count: k.number() }),
	wire: { schema: k.string(), project: (value) => String(value.count) },
})
const helper = effectOperationFactory<{ actorId: string }>()
const save = helper.command({
	...contract,
	classification: 'business',
	handler: (title, context) => title.length + context.actorId.length,
	audit: ({ command, result }) => {
		command.toUpperCase()
		result.count.toFixed()
		return null
	},
})
const assertions: [
	Assert<Equal<ContractInput<typeof input>, string>>,
	Assert<Equal<ContractOutput<typeof input>, string>>,
	Assert<Equal<ContractOutput<typeof native>, { id: GenericId<'documents'>; title?: string }>>,
	Assert<Equal<EffectOperationArgument<typeof save>, string>>,
	Assert<Equal<EffectOperationInput<typeof save>, string>>,
	Assert<Equal<EffectOperationHandlerResult<typeof save>, number>>,
	Assert<Equal<EffectOperationResult<typeof save>, { count: number }>>,
] = [true, true, true, true, true, true, true]
void assertions
const stale = { ...save, input: standardContract(k.number()) }
const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'ERROR' }),
	},
	writeAudit: () => undefined,
})
foundation.Command({
	context: (context: { actorId: string }) => context,
	// @ts-expect-error replaced schema invalidates helper evidence at the public registry boundary
	operations: () => ({ save: stale }),
})
helper.query({
	input,
	result: k.number(),
	// @ts-expect-error async schema produces a string, never a Promise or number
	handler: (input: number) => input,
})
operationContract({
	input,
	result,
	// @ts-expect-error replay must decode the final object representation
	replayResult: k.number(),
	wire: { schema: k.string(), project: (value) => String(value.count) },
})
