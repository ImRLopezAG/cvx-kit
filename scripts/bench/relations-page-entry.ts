// Times the registry work of one cold engine page query on tasks, as Convex runs
// it per call: register, build the engine planner, plan the page and bind its
// cursor scope. Database reads are out of scope. Phases are named functions so
// CPU profiles can attribute them.
import { defineSchema } from 'convex/server'
import { createPlanner } from '../../src/querying/planner'
import { defineTables, register } from './relations-fixture'

const now = () => performance.now()
const { tables, targets } = defineTables()
const schema = defineSchema(
	Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, table.table])),
)
const t0 = now()
const relations = register({ tables, targets })
const t1 = now()
const planner = createPlanner(schema, relations)
const t2 = now()
async function pageTasks(selection: Record<string, true>) {
	planner.select('tasks', selection)
	const plan = planner.plan('tasks', { numItems: 10, cursor: null }, [], [])
	// v0.1.24 had no per-query scope: it hashed the full identity on the first page.
	if (!('registryVersion' in planner)) return baselineDigest(relations.identity)
	return planner.registryVersion({
		root: 'tasks',
		path: [],
		selection,
		groups: { relations: {} },
		filters: [plan.residual],
	})
}
async function baselineDigest(text: string) {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}
await pageTasks({})
const t3 = now()
await pageTasks({ owner: true })
const t4 = now()

export const timings = {
	defineRelations: t1 - t0,
	createPlanner: t2 - t1,
	pageTasks: t3 - t2,
	pageTasksWithOwner: t4 - t3,
}
