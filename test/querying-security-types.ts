import type {
	GenericDataModel,
	GenericQueryCtx,
	GenericMutationCtx,
	GenericActionCtx,
} from 'convex/server'
import type { Rules } from '../src/tenancy'
import { createManagedSecurity } from '../src/querying/security'
import type { SecurityConfig, SecurityPolicyContext } from '../src/auth'
import { groupDeclarations } from './fixture-querying/field-groups'
import { createQueryEngine } from '../src/querying'
import { cursor } from './fixture-querying/scalar'
import type { z } from 'zod'

const legacy: Rules<unknown, GenericDataModel> = { tasks: { read: async () => true } }
const config: SecurityConfig<GenericDataModel, 'owner'> = { rules: () => legacy }
const typed: Rules<SecurityPolicyContext<GenericDataModel>, GenericDataModel> = {
	tasks: { read: async ({ db }) => !!(await db.query('tasks').first()) },
}

const groups = groupDeclarations()
const groupEngine = createQueryEngine(groups, {
	cursor,
	fieldGroups: {
		clients: {
			finance: ({ db, scope }) => {
				void db
				return scope.principal === 'user'
			},
		},
	},
})
const requiredDto = groups.relations.tables.clients.pageDto(
	{},
	{ fieldGroups: { finance: 'required' } },
)
const optionalDto = groups.relations.tables.clients.pageDto(
	{},
	{ fieldGroups: { finance: 'if-permitted' } },
)
export function groupDtoTypes(
	required: z.output<typeof requiredDto>,
	optional: z.output<typeof optionalDto>,
) {
	const amount: bigint = required.page[0].balance
	const maybe: bigint | undefined = optional.page[0].balance
	const cents: number = required.page[0].profile.cents
	// @ts-expect-error optional permission does not guarantee the native field
	const denied: bigint = optional.page[0].balance
	// @ts-expect-error unrelated private fields are absent
	void required.page[0].secret
	void [amount, maybe, cents, denied]
}
export async function groupQueryTypes(ctx: Parameters<typeof groupEngine>[0]) {
	const required = await groupEngine(ctx)
		.clients.include({ finance: 'required' })
		.paginate({ cursor: null, numItems: 1 })
	const amount: bigint = required.page[0].balance
	const optional = await groupEngine(ctx)
		.clients.include({ finance: 'if-permitted' })
		.paginate({ cursor: null, numItems: 1 })
	const maybe: bigint | undefined = optional.page[0].balance
	// @ts-expect-error denied optional keys may be absent
	const denied: bigint = optional.page[0].balance
	const plain = await groupEngine(ctx).clients.paginate({ cursor: null, numItems: 1 })
	// @ts-expect-error no opt-in means no group fields
	void plain.page[0].balance
	// @ts-expect-error unknown groups cannot be requested
	groupEngine(ctx).clients.include({ unknown: 'required' })
	// @ts-expect-error unknown mode cannot be requested
	groupEngine(ctx).clients.include({ finance: 'yes' })
	groupEngine(ctx).clients.with(
		{ accounts: true },
		// @ts-expect-error nested group options reject unknown group names alongside valid groups
		{ relations: { accounts: { fieldGroups: { finance: 'required', unknown: 'required' } } } },
	)
	groups.relations.tables.clients.pageDto(
		{},
		// @ts-expect-error DTO options reject unknown group names alongside valid groups
		{ fieldGroups: { finance: 'required', unknown: 'required' } },
	)
	const nested = await groupEngine(ctx)
		.clients.with(
			{ accounts: true },
			{
				relations: {
					accounts: { fieldGroups: { finance: 'required' } },
				},
			},
		)
		.paginate({ cursor: null, numItems: 1 })
	const target: bigint = nested.page[0].accounts.page[0].balance
	const standalone = await groupEngine(ctx)
		.clients.relation(required.page[0]._id, 'accounts')
		.include({ finance: 'if-permitted' })
		.paginate({ cursor: null, numItems: 1 })
	const targetMaybe: bigint | undefined = standalone.page[0].balance
	const variant = await groupEngine(ctx)
		.variants.include({ finance: 'required' })
		.paginate({ cursor: null, numItems: 1 })
	if (variant.page[0].kind === 'finance') {
		const big: bigint = variant.page[0].balance
		void big
	}
	void [amount, maybe, denied, target, targetMaybe]
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
