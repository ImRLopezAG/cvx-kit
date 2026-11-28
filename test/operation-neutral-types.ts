import { Foundation } from '../src/components/foundation/client'
import { kContract, standardContract, type StandardSchema } from '../src/contracts'
import { createCrudCommands } from '../src/crud'
import { k } from '../src/k'
import { kTable } from '../src/table'

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
			const parsed = k.number().safeParse(value)
			return parsed.success ? { value: { length: parsed.data } } : { issues: parsed.issues }
		},
	},
}
const typed = Command.withContext<{ actor: string }>()
typed.operation({
	command: kContract(k.string()),
	result: standardContract(resultSchema),
	replayResult: kContract(k.object({ length: k.number() })),
	classification: 'business',
	audit: ({ result }) => {
		const length: number = result.length
		void length
		return null
	},
})
typed.operation({
	command: kContract(k.string()),
	result: standardContract(resultSchema),
	// @ts-expect-error replay output must match the final result, never widen its inference
	replayResult: kContract(k.number()),
	classification: 'business',
	audit: () => null,
})
// v2 table fields cannot hold a transform; a default is the input/output split that remains: the
// caller may omit `title`, and enrich still receives the parsed (required) value.
const table = kTable(
	'notes',
	{ title: k.string().default('untitled') },
	{
		commandFields: ['title'],
	},
)
createCrudCommands({
	Command,
	table,
	aggregateType: 'note',
	actor: () => 'actor',
	enrich: (_context, command) => {
		const title: string = command.title
		void title
		return {}
	},
})
