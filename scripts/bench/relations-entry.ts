// Times each registration phase inside one cold jitless load. Phases are named
// functions so CPU profiles can attribute them.
import { getRelationExecutor } from '../../src/relations'
import { defineTables, register } from './relations-fixture'

const now = () => performance.now()
function touchTasks(relations: ReturnType<typeof register>) {
	// SAFETY: the fixture declares tasks.owner and the content group at runtime; types are erased.
	const tasks = relations.tables.tasks as unknown as {
		paginationOpts(selection: object): unknown
		pageDto(selection: object, groups: object): unknown
	}
	tasks.paginationOpts({ status: true, owner: { status: true } })
	tasks.pageDto({ owner: true }, { fieldGroups: { content: 'required' } })
}
// The registry work a tasks page query adds to bind its cursors, without and
// with a selected relation.
function scopeTasks(relations: ReturnType<typeof register>) {
	return getRelationExecutor(relations).scopedIdentity(['tasks'], [])
}
function scopeTasksOwner(relations: ReturnType<typeof register>) {
	return getRelationExecutor(relations).scopedIdentity(['tasks'], [['tasks', 'owner']])
}
function readIdentity(relations: ReturnType<typeof register>) {
	return relations.identity
}
const t0 = now()
const defined = defineTables()
const t1 = now()
const relations = register(defined)
const t2 = now()
touchTasks(relations)
const t3 = now()
const scoped = scopeTasks(relations)
const t4a = now()
scopeTasksOwner(relations)
const t4 = now()
const identity = readIdentity(relations)
const t5 = now()

export const timings = {
	zodTables: t1 - t0,
	defineRelations: t2 - t1,
	touchTasks: t3 - t2,
	scopeTasks: t4a - t3,
	scopeTasksOwner: t4 - t4a,
	identity: t5 - t4,
	scopedLength: scoped.length,
	identityLength: identity.length,
}
