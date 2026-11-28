import { k } from '../../src/k'
import { defineSchema } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { kTable } from '../../src/table'
import { defineRelations } from '../../src/relations'
import { createQueryEngine } from '../../src/querying'
import { cursor } from './scalar'

/** Realistic metadata cardinality; root workload remains bounded and scalar. */
export function largeRegistry(extra = false) {
	const makeTable = (name: string) =>
		kTable(
			name,
			{
				ordinal: k.number(),
				department: k.string(),
				status: k.string(),
				tenant: k.string(),
				description: k.string(),
				active: k.boolean(),
				rank: k.number(),
				code: k.string(),
				optional: k.string().optional(),
				details: k.object({ text: k.string(), tags: k.array(k.string()) }),
				secret: k.string(),
				credential: k.string(),
			},
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
