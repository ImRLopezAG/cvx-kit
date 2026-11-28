import { k } from '../../src/k'
import { defineSchema, type DataModelFromSchemaDefinition } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { kTable } from '../../src/table'
import { defineRelations } from '../../src/relations'
import { createQueryEngine } from '../../src/querying'
import { cursor, managed, observed } from './scalar'

export function relationshipStressFixture() {
	const tasks = kTable(
		'tasks',
		{
			ordinal: k.number(),
			tenant: k.string(),
			department: k.string(),
			status: k.string(),
			active: k.boolean(),
			priority: k.number(),
			authorized: k.boolean(),
		},
		{ publicFields: ['ordinal'] },
	)
	const labels = kTable(
		'labels',
		{ ordinal: k.number(), tenant: k.string(), authorized: k.boolean(), name: k.string() },
		{ publicFields: ['ordinal', 'name'] },
	)
	const edges = kTable('edges', {
		task: k.id('tasks'),
		label: k.id('labels'),
		authorized: k.boolean(),
		ordinal: k.number(),
	})
	tasks.table.index('by_tenant_department_status', ['tenant', 'department', 'status'])
	edges.table.index('by_task', ['task'])
	const schema = defineSchema({ tasks: tasks.table, labels: labels.table, edges: edges.table })
	const relations = defineRelations({ tasks, labels, edges }, (r) => ({
		tasks: {
			labels: r.many.labels({
				from: r.tasks._id.through(r.edges.task),
				to: r.labels._id.through(r.edges.label),
			}),
		},
	}))
	const { createTest } = defineTestApp({ schema }).defineModules({})
	const t = createTest()
	const querying = createQueryEngine({
		schema,
		relations,
		cursor,
		budgets: {
			readOperations: 100000,
			indexRanges: 100000,
			rawCandidates: 100000,
			documentBytes: 64 * 1024 * 1024,
			fanout: 100000,
			memoEntries: 100000,
		},
	})
	type DM = DataModelFromSchemaDefinition<typeof schema>
	function context(db: Parameters<typeof observed<DM>>[0]) {
		const o = observed<DM>(db)
		return {
			...o,
			ctx: managed(o.raw, {
				tasks: { read: async (_, row) => row.tenant === 'a' && row.authorized },
				labels: { read: async (_, row) => row.tenant === 'a' && row.authorized },
				edges: { read: async (_, row) => row.authorized },
			}),
		}
	}
	return { t, querying, context }
}

export async function seedRelationshipStress(f: ReturnType<typeof relationshipStressFixture>) {
	const original = Date.now
	let clock = 2 ** 44
	Date.now = () => clock++
	try {
		return await f.t.run(async (ctx) => {
			const labels = []
			for (let i = 0; i < 80; i++)
				labels.push(
					await ctx.db.insert('labels', {
						ordinal: i,
						tenant: i % 7 ? 'a' : 'b',
						authorized: i % 5 !== 0,
						name: `label-${i}`,
					}),
				)
			const tasks = []
			for (let i = 0; i < 2200; i++)
				tasks.push(
					await ctx.db.insert('tasks', {
						ordinal: i,
						tenant: i % 7 ? 'a' : 'b',
						department: ['support', 'sales', 'engineering'][i % 3],
						status: ['open', 'done', 'blocked'][Math.floor(i / 3) % 3],
						active: i % 2 === 0,
						priority: Math.floor(i / 9) % 5,
						authorized: i >= 200 && i % 11 !== 0,
					}),
				)
			for (let i = 0; i < 2200; i++)
				for (let j = 0; j < 5; j++)
					await ctx.db.insert('edges', {
						ordinal: i * 5 + j,
						task: tasks[i],
						label: labels[(i + j * 17) % 80],
						authorized: i % 37 !== 0 && (i + j) % 13 !== 0,
					})
			for (let i = 0; i < 100; i++)
				await ctx.db.insert('edges', {
					ordinal: 11000 + i,
					task: tasks[200 + i],
					label: labels[(200 + i + 17) % 80],
					authorized: true,
				})
			return { tasks, labels }
		})
	} finally {
		Date.now = original
	}
}
