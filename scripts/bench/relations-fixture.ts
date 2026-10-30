// Registration benchmark fixture: an Accord-sized registry (88 tables) with an
// edge graph, a polymorphic ID field, field groups and a variant table.
import { z } from 'zod'
import { zid, zodTable, zodVariantTable } from '../../src/zod-table'
import { defineRelations } from '../../src/relations'

export const ENTITY_COUNT = 84

export function defineTables() {
	const entity = (name: string, parent: string) =>
		zodTable(
			name,
			(id) => ({
				parentId: id(parent).optional(),
				ref: z.string(),
				ordinal: z.number(),
				status: z.enum(['open', 'closed', 'archived']),
				title: z.string(),
				description: z.string().optional(),
				active: z.boolean(),
				rank: z.number(),
				code: z.string(),
				tags: z.array(z.string()),
				details: z.object({ text: z.string(), notes: z.array(z.string()).optional() }),
				secret: z.string(),
			}),
			{
				publicFields: [
					'parentId',
					'ref',
					'ordinal',
					'status',
					'title',
					'description',
					'active',
					'rank',
					'code',
					'tags',
					'details',
				],
			},
		)
	const tables: Record<string, ReturnType<typeof entity>> = {}
	for (let i = 0; i < ENTITY_COUNT; i++) {
		const name = `entity${i}`
		const table = entity(name, `entity${Math.max(0, i - 1)}`)
		table.table
			.index('by_parentId', ['parentId'])
			.index('by_ref', ['ref'])
			.index('by_status_rank', ['status', 'rank'])
		tables[name] = table
	}
	const targets = Array.from({ length: 8 }, (_, i) => `entity${i}`)
	const tasks = Object.assign(
		zodTable(
			'tasks',
			(id) => ({
				title: z.string(),
				status: z.enum(['todo', 'done']),
				rel: z.union([
					id('entity0'),
					id('entity1'),
					id('entity2'),
					id('entity3'),
					id('entity4'),
					id('entity5'),
					id('entity6'),
					id('entity7'),
				]),
				ownerId: id('entity0'),
				priority: z.number(),
				body: z.string(),
				internal: z.string(),
			}),
			{ publicFields: ['title', 'status', 'rel', 'ownerId', 'priority'] },
		),
		{ fieldGroups: { content: ['body'] } },
	)
	tasks.table.index('by_rel', ['rel']).index('by_ownerId', ['ownerId'])
	const payments = zodVariantTable(
		'payments',
		z.discriminatedUnion('type', [
			z.strictObject({ type: z.literal('card'), entityId: zid('entity1'), amount: z.number() }),
			z.strictObject({ type: z.literal('wire'), entityId: zid('entity1'), amount: z.number() }),
		]),
		{
			discriminator: 'type',
			variants: {
				card: { publicFields: ['entityId', 'amount'] },
				wire: { publicFields: ['entityId', 'amount'] },
			},
		},
	)
	payments.table.index('by_type_entityId', ['type', 'entityId'])
	const notes = zodTable('notes', (id) => ({ taskId: id('tasks'), text: z.string() }), {
		publicFields: ['taskId', 'text'],
	})
	notes.table.index('by_taskId', ['taskId'])
	return { tables: { ...tables, tasks, payments, notes }, targets }
}

type RuntimeBuilder = Record<string, any>
// SAFETY: runtime registration is identical for generated names; only the static types are erased.
const runtimeRelations = defineRelations as unknown as (
	tables: ReturnType<typeof defineTables>['tables'],
	declare: (r: RuntimeBuilder, branch: (table: string, tag: string) => RuntimeBuilder) => object,
) => ReturnType<typeof defineRelations<ReturnType<typeof defineTables>['tables'], {}>>

export function register({ tables, targets }: ReturnType<typeof defineTables>) {
	return runtimeRelations(tables, (r, branch) => {
		const declarations: Record<string, Record<string, unknown>> = {
			tasks: {
				owner: r.one.entity0({ from: r.tasks.ownerId, to: r.entity0._id }),
				notes: r.many.notes({ from: r.tasks._id, to: r.notes.taskId }),
			},
			entity1: {
				payments: r.many.payments({ from: r.entity1._id, to: branch('payments', 'card').entityId }),
			},
		}
		for (const target of targets)
			(declarations[target] ??= {}).tasks = r.many.tasks({
				from: r[target]._id,
				to: r.tasks.rel.forTable(target),
			})
		// Parent/child chain across half the registry, like domain aggregates.
		for (let i = 1; i < 40; i++)
			(declarations[`entity${i}`] ??= {}).parent = r.one[`entity${i - 1}`]({
				from: r[`entity${i}`].parentId,
				to: r[`entity${i - 1}`]._id,
			})
		return declarations
	})
}
