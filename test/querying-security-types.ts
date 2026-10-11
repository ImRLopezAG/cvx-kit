import type {
	GenericDataModel,
	GenericQueryCtx,
	GenericMutationCtx,
	GenericActionCtx,
} from 'convex/server'
import type { Rules } from '../src/tenancy'
import { createManagedSecurity } from '../src/querying/security'
import type { SecurityConfig, SecurityPolicyContext } from '../src/auth'

const legacy: Rules<unknown, GenericDataModel> = { tasks: { read: async () => true } }
const config: SecurityConfig<GenericDataModel, 'owner'> = { rules: () => legacy }
const typed: Rules<SecurityPolicyContext<GenericDataModel>, GenericDataModel> = {
	tasks: { read: async ({ db }) => !!(await db.query('tasks').first()) },
}
void config
void typed
const managed = createManagedSecurity({ tables: ['tasks'], policyVersion: '1' })
export function contextTypes(
	query: GenericQueryCtx<GenericDataModel>,
	mutation: GenericMutationCtx<GenericDataModel>,
	action: GenericActionCtx<GenericDataModel>,
) {
	managed(query)
	managed({ ...query, tenant: 'ignored' })
	// @ts-expect-error a native mutation database is a writer, never a query capability
	managed(mutation)
	// @ts-expect-error actions do not supply a query database
	managed(action)
}
