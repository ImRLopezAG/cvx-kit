import { z } from 'zod'
import type { GenericId } from 'convex/values'
import { defineRelations } from '../src/relations'
import { zodTable } from '../src/zod-table'

const tasks = zodTable(
	'tasks',
	(id) => ({
		title: z.string(),
		reference: id('tasks').nullable(),
		other: id('labels'),
		status: z.enum(['open', 'done']).nullable(),
	}),
	{ publicFields: ['title'] },
)
const labels = zodTable('labels', () => ({ name: z.string() }), { publicFields: ['name'] })
const links = zodTable('links', (id) => ({ taskId: id('tasks'), labelId: id('labels') }))
links.table.index('by_task', ['taskId'])
const tables = { tasks, labels, links }
const registry = defineRelations(tables, (r) => ({
	tasks: {
		referencedTask: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }),
		labels: r.many.labels({
			from: r.tasks._id.through(r.links.taskId),
			to: r.labels._id.through(r.links.labelId),
		}),
	},
}))
const page = registry.tables.tasks.pageDto({
	referencedTask: { referencedTask: true },
	labels: true,
})
const output = page.parse({})
const id: GenericId<'tasks'> = output.page[0]._id
const nestedId: GenericId<'tasks'> | undefined = output.page[0].referencedTask?.referencedTask?._id
const labelId: GenericId<'labels'> = output.page[0].labels.page[0]._id
void [id, nestedId, labelId]
// @ts-expect-error target private storage fields never enter DTOs
void output.page[0].referencedTask?.other
// @ts-expect-error one always nullable even for required reference
const required: GenericId<'tasks'> = output.page[0].referencedTask._id
void required
defineRelations(tables, (r) => ({
	// @ts-expect-error unknown tables have no builders
	tasks: { bad: r.one.missing({ from: r.tasks.reference, to: r.tasks._id }) },
}))
defineRelations(tables, (r) => ({
	// @ts-expect-error unknown fields are not references
	tasks: { bad: r.one.tasks({ from: r.tasks.missing, to: r.tasks._id }) },
}))
defineRelations(tables, (r) => ({
	// @ts-expect-error wrong ID brands are incompatible
	tasks: { bad: r.one.tasks({ from: r.tasks.other, to: r.tasks._id }) },
}))
defineRelations(tables, (r) => ({
	// @ts-expect-error from table must match declaration bucket
	labels: { bad: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }) },
}))
defineRelations(tables, (r) => ({
	// @ts-expect-error scalar names collide with relationships
	tasks: { title: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }) },
}))
defineRelations(tables, (r) => ({
	tasks: {
		bad: r.many.labels({
			// @ts-expect-error through legs must match native brands
			from: r.tasks._id.through(r.links.labelId),
			to: r.labels._id.through(r.links.labelId),
		}),
	},
}))
defineRelations(tables, (r) => ({
	// @ts-expect-error both legs must use through
	tasks: { bad: r.many.labels({ from: r.tasks._id.through(r.links.taskId), to: r.labels._id }) },
}))
defineRelations(tables, (r) => ({
	// @ts-expect-error builder target must match to table
	tasks: { bad: r.one.labels({ from: r.tasks.reference, to: r.tasks._id }) },
}))
// @ts-expect-error unknown relationship selection
registry.tables.tasks.pageDto({ unknown: true })
registry.tables.tasks.pageDto({
	referencedTask: {
		// @ts-expect-error selection depth is finite at four relation edges
		referencedTask: { referencedTask: { referencedTask: { referencedTask: true } } },
	},
})
// @ts-expect-error unknown nested relationship selection
registry.tables.tasks.pageDto({ referencedTask: { unknown: true } })
// @ts-expect-error relation filter needs explicit target scalar mask
registry.tables.tasks.paginationOpts({ referencedTask: true })
// @ts-expect-error unknown nested filter field
registry.tables.tasks.paginationOpts({ referencedTask: { unknown: true } })
const opts = registry.tables.tasks.paginationOpts({
	reference: true,
	status: true,
	referencedTask: { title: true, referencedTask: { title: true } },
	labels: { name: true },
})
const input: z.input<typeof opts> = {
	numItems: 1,
	cursor: null,
	filters: {
		reference: 'tasks:1',
		status: null,
		referencedTask: { and: [{ title: 't' }] },
		labels: { none: { name: 'n' } },
	},
}
const parsed = opts.parse(input)
const branded: NonNullable<z.output<typeof opts>['filters']>['reference'] =
	parsed.filters?.reference
void branded
declare const labelBrand: GenericId<'labels'>
// @ts-expect-error different native table brand
const wrong: Extract<NonNullable<z.output<typeof opts>['filters']>['reference'], string> =
	labelBrand
void wrong
const bad: z.input<typeof opts> = {
	numItems: 1,
	cursor: null,
	// @ts-expect-error fields outside explicit endpoint mask stay absent
	filters: { referencedTask: { other: 'labels:1' } },
}
void bad
const badMany: z.input<typeof opts> = {
	numItems: 1,
	cursor: null,
	// @ts-expect-error unknown many operators
	filters: { labels: { all: {} } },
}
void badMany
const depthOpts = registry.tables.tasks.paginationOpts({
	title: true,
	referencedTask: { title: true },
	labels: { name: true },
})
const boundary: z.input<typeof depthOpts> = {
	numItems: 1,
	cursor: null,
	filters: { and: [{ not: { or: [{ referencedTask: { title: 't' } }] } }] },
}
void boundary
const tooDeep: z.input<typeof depthOpts> = {
	numItems: 1,
	cursor: null,
	// @ts-expect-error mixed boolean/relation target depth five exceeds grammar
	filters: { and: [{ not: { or: [{ referencedTask: { not: { title: 't' } } }] } }] },
}
void tooDeep
const scalar = tasks.paginationOpts({ title: true })
const scalarDeep: z.input<typeof scalar> = {
	numItems: 1,
	cursor: null,
	// @ts-expect-error scalar boolean depth five exceeds the shared grammar
	filters: { not: { not: { not: { not: { not: { title: 't' } } } } } },
}
void scalarDeep
// @ts-expect-error nested mask cannot add unknown keys alongside valid keys
registry.tables.tasks.paginationOpts({ referencedTask: { title: true, unknown: true } })
// @ts-expect-error nested output mask cannot add unknown keys alongside valid keys
registry.tables.tasks.pageDto({ referencedTask: { referencedTask: true, unknown: true } })
const links2 = zodTable('links2', (id) => ({ taskId: id('tasks'), labelId: id('labels') }))
defineRelations({ ...tables, links2 }, (r) => ({
	tasks: {
		// @ts-expect-error junction tables must be identical
		bad: r.many.labels({
			from: r.tasks._id.through(r.links.taskId),
			to: r.labels._id.through(r.links2.labelId),
		}),
	},
}))
defineRelations(tables, (r) => ({
	// @ts-expect-error incompatible nullable enum domains fail statically
	tasks: { bad: r.one.tasks({ from: r.tasks.status, to: r.tasks.title }) },
}))
