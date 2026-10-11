import { z } from 'zod'
import { defineSchema } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { zodTable } from '../../src/zod-table'
import { defineRelations } from '../../src/relations'
import { createQueryEngine } from '../../src/querying'
import { cursor } from './scalar'

/** Realistic metadata cardinality; root workload remains bounded and scalar. */
export function largeRegistry(extra = false) {
	const makeTable = (name: string) =>
		zodTable(
			name,
			() => ({
				ordinal: z.number(),
				department: z.string(),
				status: z.string(),
				tenant: z.string(),
				description: z.string(),
				active: z.boolean(),
				rank: z.number(),
				code: z.string(),
				optional: z.string().optional(),
				details: z.object({ text: z.string(), tags: z.array(z.string()) }),
				secret: z.string(),
				credential: z.string(),
			}),
			{
				publicFields: [
					'ordinal',
					'department',
					'status',
					'description',
					'active',
					'rank',
					'code',
					'optional',
					'details',
				],
			},
		)
	const tables: Record<string, ReturnType<typeof makeTable>> = {}
	for (let i = 0; i < 32; i++) {
		const name = i ? `entity${i}` : 'tasks'
		const table = makeTable(name)
		table.table.index('by_department', ['department']).index('by_status', ['status'])
		if (extra) table.table.index('by_rank', ['rank'])
		tables[name] = table
	}
	const native = Object.fromEntries(Object.entries(tables).map(([name, t]) => [name, t.table]))
	const schema = defineSchema(native)
	const relations = defineRelations(tables, () => ({}))
	const { createTest } = defineTestApp({ schema }).defineModules({})
	return {
		schema,
		relations,
		t: createTest(),
		querying: createQueryEngine({ schema, relations, cursor }),
	}
}
