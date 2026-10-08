import { z } from 'zod'
import {
	bindOperationExecutor,
	createOperationTools,
	selectOperation,
	operationToolDialect,
} from '../src/modules/contracts/exposure'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
const owner = Symbol('documents')
const otherOwner = Symbol('other')
const input = z.object({ title: z.string().transform((text) => text.length) })
const selected = selectOperation(owner, 'mutation', 'rename', {
	input,
	result: z.number().transform(String),
	wire: { schema: z.string().transform(Number) },
})
const executor = bindOperationExecutor(selected, {
	owner,
	key: 'rename',
	execute: async (raw) => String(raw.title.length),
})
const converter = {
	dialect: operationToolDialect,
	convert: (_schema: typeof input) => ({
		type: 'object',
		properties: { title: { type: 'string' } },
		required: ['title'],
	}),
}
const tools = createOperationTools({
	rename_document: { operation: selected, executor, description: 'Rename', converter },
})
type Keys = Assert<Equal<keyof typeof tools, 'rename_document'>>
type RawInput = Assert<Equal<Parameters<typeof tools.rename_document.invoke>[0], { title: string }>>
type PublicWire = Assert<
	Equal<
		Extract<Awaited<ReturnType<typeof tools.rename_document.invoke>>, { _tag: 'Success' }>['value'],
		string
	>
>
const assertions: [Keys, RawInput, PublicWire] = [true, true, true]
void assertions
// @ts-expect-error full registry is not discoverable
selected.operations
// @ts-expect-error unselected tools do not exist
tools.archive_document
// @ts-expect-error decoded domain value cannot substitute for raw transport
tools.rename_document.invoke({ title: 12 })
// @ts-expect-error arguments cannot supply authority
tools.rename_document.invoke({ title: 'Name', tenant: 'forged' })
// @ts-expect-error incompatible owner
bindOperationExecutor(selected, { owner: otherOwner, key: 'rename', execute: async () => 'wire' })
// @ts-expect-error incompatible operation key
bindOperationExecutor(selected, { owner, key: 'archive', execute: async () => 'wire' })
// @ts-expect-error native executor returns wire input string, not decoded wire output number
bindOperationExecutor(selected, { owner, key: 'rename', execute: async () => 12 })
bindOperationExecutor(selected, {
	owner,
	key: 'rename',
	// @ts-expect-error native executor must accept raw title string
	execute: async (_raw: { title: number }) => 'wire',
})
const other = selectOperation(otherOwner, 'query', 'get', {
	input: z.object({ id: z.string() }),
	result: z.boolean(),
})
const otherExecutor = bindOperationExecutor(other, {
	owner: otherOwner,
	key: 'get',
	execute: async () => true,
})
createOperationTools({
	// @ts-expect-error unrelated executor cannot authorize selected operation
	invalid: { operation: selected, executor: otherExecutor, description: 'Bad', converter },
})
// @ts-expect-error missing executor
createOperationTools({ invalid: { operation: selected, description: 'Bad', converter } })
createOperationTools({
	// @ts-expect-error incompatible converter schema input
	invalid: {
		operation: selected,
		executor,
		description: 'Bad',
		converter: {
			dialect: operationToolDialect,
			convert: (_schema: z.ZodNumber) => ({ type: 'object' }),
		},
	},
})
