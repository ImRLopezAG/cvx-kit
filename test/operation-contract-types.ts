import { z } from 'zod'
import { v, type GenericId } from 'convex/values'
import {
	convexContract,
	operationContract,
	standardContract,
	type ContractInput,
	type ContractOutput,
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
const input = standardContract(z.string().transform(async (title) => title.trim()))
const native = convexContract(v.object({ id: v.id('documents'), title: v.optional(v.string()) }))
const result = z.number().transform(async (count) => ({ count }))
const contract = operationContract({
	input,
	result,
	replayResult: z.object({ count: z.number() }),
	wire: { schema: z.string(), project: (value) => String(value.count) },
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
const stale = { ...save, input: standardContract(z.number()) }
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
	result: z.number(),
	// @ts-expect-error async schema produces a string, never a Promise or number
	handler: (input: number) => input,
})
operationContract({
	input,
	result,
	// @ts-expect-error replay must decode the final object representation
	replayResult: z.number(),
	wire: { schema: z.string(), project: (value) => String(value.count) },
})
