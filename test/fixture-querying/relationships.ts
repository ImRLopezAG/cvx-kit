import { z } from 'zod'
import { defineSchema, type DataModelFromSchemaDefinition } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { zodTable } from '../../src/zod-table'
import { defineRelations } from '../../src/relations'
import { createQueryEngine } from '../../src/querying'
import { cursor, managed, observed } from './scalar'
import type { ManagedBudgets } from '../../src/querying/security'

export function relationshipFixture(budgets?: Partial<ManagedBudgets>) {
	const tasks = zodTable(
		'tasks',
		(id) => ({
			ordinal: z.number(),
			tenant: z.string(),
			allowed: z.boolean(),
			reference: id('tasks').nullable().optional(),
			required: id('labels'),
			code: z.string(),
		}),
		{ publicFields: ['ordinal', 'code'] },
	)
	const labels = zodTable(
		'labels',
		(id) => ({
			ordinal: z.number(),
			tenant: z.string(),
			allowed: z.boolean(),
			code: z.string(),
			task: id('tasks').optional(),
		}),
		{ publicFields: ['ordinal', 'code'] },
	)
	const edges = zodTable('edges', (id) => ({
		task: id('tasks'),
		label: id('labels'),
		labelCode: z.string().optional(),
		allowed: z.boolean(),
	}))
	tasks.table.index('by_code', ['code'])
	labels.table
		.index('by_task', ['task'])
		.index('by_code', ['code'])
		.index('by_task_code', ['task', 'code'])
		.index('by_code_ordinal', ['code', 'ordinal'])
	edges.table.index('by_task', ['task'])
	const relations = defineRelations({ tasks, labels, edges }, (r) => ({
		tasks: {
			referenceTask: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }),
			requiredLabel: r.one.labels({ from: r.tasks.required, to: r.labels._id }),
			byCode: r.one.labels({ from: r.tasks.code, to: r.labels.code }),
			direct: r.many.labels({ from: r.tasks._id, to: r.labels.task }),
			labels: r.many.labels({
				from: r.tasks._id.through(r.edges.task),
				to: r.labels._id.through(r.edges.label),
			}),
			aliasLabels: r.many.labels({
				from: r.tasks._id.through(r.edges.task),
				to: r.labels._id.through(r.edges.label),
			}),
			codeLabels: r.many.labels({
				from: r.tasks._id.through(r.edges.task),
				to: r.labels.code.through(r.edges.labelCode),
			}),
		},
		labels: { owner: r.one.tasks({ from: r.labels.task, to: r.tasks._id }) },
	}))
	const schema = defineSchema({ tasks: tasks.table, labels: labels.table, edges: edges.table })
	const { createTest } = defineTestApp({ schema }).defineModules({})
	const t = createTest()
	const querying = createQueryEngine({ schema, relations, cursor, budgets })
	type DM = DataModelFromSchemaDefinition<typeof schema>
	const context = (db: Parameters<typeof observed<DM>>[0]) => {
		const o = observed<DM>(db)
		return {
			...o,
			ctx: managed(o.raw, {
				tasks: { read: async (_, d) => d.allowed && d.tenant === 'one' },
				labels: { read: async (_, d) => d.allowed && d.tenant === 'one' },
				edges: { read: async (_, d) => d.allowed },
			}),
		}
	}
	return { tasks, labels, edges, relations, schema, t, querying, context }
}

export async function seedRelationships(f: ReturnType<typeof relationshipFixture>) {
	const original = Date.now
	Date.now = () => 2 ** 44
	try {
		return await f.t.run(async (ctx) => {
			const labels = []
			for (let ordinal = 0; ordinal < 8; ordinal++) {
				const id = await ctx.db.insert('labels', {
					ordinal,
					code: ordinal < 2 ? 'shared' : `c${ordinal}`,
					allowed: ordinal !== 0,
					tenant: ordinal === 2 ? 'two' : 'one',
				})
				labels.push((await ctx.db.get(id))!)
			}
			const tasks = []
			for (let ordinal = 0; ordinal < 6; ordinal++) {
				const id = await ctx.db.insert('tasks', {
					ordinal,
					code: 'shared',
					required: labels[1]._id,
					allowed: ordinal !== 0,
					tenant: 'one',
				})
				tasks.push((await ctx.db.get(id))!)
			}
			await ctx.db.patch(tasks[1]._id, { reference: tasks[2]._id })
			await ctx.db.patch(tasks[2]._id, { reference: tasks[0]._id })
			await ctx.db.patch(tasks[3]._id, { reference: null })
			for (const l of labels) await ctx.db.patch(l._id, { task: tasks[1]._id })
			const edges = []
			for (const task of tasks.slice(0, 4))
				for (const ordinal of [0, 2, 3, 1, 1, 4, 5]) {
					const id = await ctx.db.insert('edges', {
						task: task._id,
						label: labels[ordinal]._id,
						labelCode: labels[ordinal].code,
						allowed: ordinal !== 3,
					})
					edges.push((await ctx.db.get(id))!)
				}
			return {
				tasks: await Promise.all(tasks.map((t) => ctx.db.get(t._id).then((r) => r!))),
				labels: await Promise.all(labels.map((l) => ctx.db.get(l._id).then((r) => r!))),
				edges,
			}
		})
	} finally {
		Date.now = original
	}
}
