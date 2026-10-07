import { Foundation } from '../src/components/foundation/client'
import { zodContract, standardContract, type StandardSchema } from '../src/contracts'
import { createCrudCommands } from '../src/crud'
import { zodTable } from '../src/zod-table'
import { z } from 'zod'

const { Command } = new Foundation(
	{ functions: { status: null } },
	{
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'ERROR' }),
		},
	},
)
const resultSchema: StandardSchema<number, { length: number }> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate: async (value) => {
			const parsed = z.number().safeParse(value)
			return parsed.success ? { value: { length: parsed.data } } : { issues: parsed.error.issues }
		},
	},
}
const typed = Command.withContext<{ actor: string }>()
typed.operation({
	command: zodContract(z.string()),
	result: standardContract(resultSchema),
	replayResult: zodContract(z.object({ length: z.number() })),
	classification: 'business',
	audit: ({ result }) => {
		const length: number = result.length
		void length
		return null
	},
})
typed.operation({
	command: zodContract(z.string()),
	result: standardContract(resultSchema),
	// @ts-expect-error replay output must match the final result, never widen its inference
	replayResult: zodContract(z.number()),
	classification: 'business',
	audit: () => null,
})
const table = zodTable('notes', () => ({ title: z.string().transform((value) => value.length) }), {
	commandFields: ['title'],
})
createCrudCommands({
	Command,
	table,
	aggregateType: 'note',
	actor: () => 'actor',
	enrich: (_context, command) => {
		const title: number = command.title
		void title
		return {}
	},
})
