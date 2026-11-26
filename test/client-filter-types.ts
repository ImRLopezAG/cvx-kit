import { defineSchema, type DataModelFromSchemaDefinition } from 'convex/server'
import type { k } from '../src/k'
import { createQueryEngine } from '../src/querying'
import type { ManagedQueryContext } from '../src/querying/security'
import { v, type GenericId } from 'convex/values'
import { defineFilterContract, type SharedFilters } from '../src/filters'
import { kTable } from '../src/table'
import { defineRelations } from '../src/relations-public'
const fields = {
	status: v.union(v.literal('open'), v.literal('done')),
	id: v.id('tasks'),
	big: v.optional(v.int64()),
	active: v.boolean(),
}
const contract = defineFilterContract(fields)
const table = kTable('tasks', contract.fields)
const options = defineRelations({ tasks: table }, () => ({})).tables.tasks.filters(contract)
const value: SharedFilters<typeof fields> = {
	status: { in: ['open'] },
	big: { gte: 1n },
	active: true,
}
const id: GenericId<'tasks'> = contract.fields.id.parse('native-id')
// @ts-expect-error a shared native ID retains its own table brand
const wrongId: GenericId<'other'> = contract.fields.id.parse('native-id')
void wrongId
void [value, id, options]
// @ts-expect-error enum literals remain exact
const badEnum: SharedFilters<typeof fields> = { status: 'other' }
// @ts-expect-error boolean predicates do not accept ranges
const badRange: SharedFilters<typeof fields> = { active: { gt: true } }
// @ts-expect-error nonoptional fields cannot use exists
const badExists: SharedFilters<typeof fields> = { status: { exists: false } }
// @ts-expect-error bigint remains bigint
const badBig: SharedFilters<typeof fields> = { big: 1 }
// @ts-expect-error scalar contract does not invent relation grammar
const badRelation: SharedFilters<typeof fields> = { relation: { some: {} } }
void [badEnum, badRange, badExists, badBig, badRelation]

// @ts-expect-error native IDs do not accept range operators
const badIdRange: SharedFilters<typeof fields> = { id: { gt: id } }
void badIdRange
contract.searchParam.encode({ id: 'raw-browser-input' })

// Regression (TS2589): paginating with a contract binding's parsed args stays within type depth.
const records = kTable('records', contract.fields)
const recordRelations = defineRelations({ records }, () => ({}))
const recordSchema = defineSchema({ records: records.table })
const recordEngine = createQueryEngine({ schema: recordSchema, relations: recordRelations })
const recordOptions = recordRelations.tables.records.filters(contract)
declare const recordCtx: ManagedQueryContext<DataModelFromSchemaDefinition<typeof recordSchema>>
declare const recordArgs: k.infer<typeof recordOptions>
void recordEngine(recordCtx).records.paginate(recordArgs)
