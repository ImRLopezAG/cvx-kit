// Times each registration phase inside one cold jitless load.
import { defineTables, register } from './relations-fixture'

const now = () => performance.now()
const t0 = now()
const defined = defineTables()
const t1 = now()
const relations = register(defined)
const t2 = now()
const tables = relations.tables as any
tables.tasks.paginationOpts({ status: true, owner: { status: true } })
tables.tasks.pageDto({ owner: true }, { fieldGroups: { content: 'required' } })
const t3 = now()
const identity = relations.identity
const t4 = now()

export const timings = {
	zodTables: t1 - t0,
	defineRelations: t2 - t1,
	touchTasks: t3 - t2,
	identity: t4 - t3,
	identityLength: identity.length,
}
