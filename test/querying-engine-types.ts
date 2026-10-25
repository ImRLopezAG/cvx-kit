import type { GenericMutationCtx } from 'convex/server'
import type { GenericId } from 'convex/values'
import type { ManagedQueryContext } from '../src/querying/security'
import { createQueryEngine } from '../src/querying'
import { declarations, cursor, type DM } from './fixture-querying/scalar'

const f = declarations()
const querying = createQueryEngine({ schema: f.schema, relations: f.relations, cursor })
declare const ctx: ManagedQueryContext<DM>
const tasks = querying(ctx).tasks
const output = tasks
	.when(false, 'by_active')
	.where({ tenant: 'one', big: { gte: 0n } })
	.with({})
	.paginate({ numItems: 10, cursor: null, filters: { status: 'open' } })
output.then((page) => {
	const id: GenericId<'tasks'> = page.page[0]._id
	void id
	// @ts-expect-error storage secrets are excluded from strict public DTOs
	void page.page[0].secret
})
// @ts-expect-error predicates are declarative, not callbacks
tasks.where(() => true)
// @ts-expect-error projection callbacks are not supported
tasks.with(() => ({}))
// @ts-expect-error custom ordering callbacks are not supported
tasks.paginate({ numItems: 1, cursor: null, order: () => 0 })
// @ts-expect-error endpoint crypto knobs are not accepted
tasks.paginate({ numItems: 1, cursor: null, cursorKey: 'local' })
// @ts-expect-error unknown declared relations are rejected
tasks.with({ missing: true })
// @ts-expect-error bigint filters preserve native scalar types
tasks.where({ big: 0 })
// @ts-expect-error unknown tables are absent from the facade
void querying(ctx).missing
declare const mutation: GenericMutationCtx<DM>
// @ts-expect-error known mutation contexts cannot obtain a query capability
querying(mutation)

const ordered = tasks
	.orderBy('by_department_count')
	.where({ status: 'open' })
	.with({})
	.orderBy('by_count')
void ordered
// @ts-expect-error unknown index names must not widen to string
tasks.orderBy('unknown')
// @ts-expect-error foreign table indexes cannot sort permissions
querying(ctx).permissions.orderBy('by_count')
