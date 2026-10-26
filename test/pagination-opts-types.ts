import { z } from 'zod'
import {
	defineSchema,
	queryGeneric,
	mutationGeneric,
	actionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	internalActionGeneric,
	type DataModelFromSchemaDefinition,
} from 'convex/server'
import type { GenericId } from 'convex/values'
import { createAuthFunctions } from '../src/auth'
import { defineRelations } from '../src/relations'
import { zodTable } from '../src/zod-table'

const tasks = zodTable('tasks', (id) => ({ title: z.string(), parent: id('tasks').optional() }), {
	publicFields: ['title'],
})
const schema = defineSchema({ tasks: tasks.table })
const registry = defineRelations({ tasks }, (r) => ({
	tasks: { parentTask: r.one.tasks({ from: r.tasks.parent, to: r.tasks._id }) },
}))
const scalar = tasks.paginationOpts({ parent: true, title: true })
const relational = registry.tables.tasks.paginationOpts({
	parent: true,
	parentTask: { title: true },
})
const auth = createAuthFunctions<DataModelFromSchemaDefinition<typeof schema>, 'viewer'>({
	query: queryGeneric,
	mutation: mutationGeneric,
	action: actionGeneric,
	internalQuery: internalQueryGeneric,
	internalMutation: internalMutationGeneric,
	internalAction: internalActionGeneric,
	getAuthUser: async () => ({ id: 'user' }),
	mapRole: () => 'viewer',
	adminRoles: [],
})

auth.authQuery({
	args: scalar,
	returns: z.null(),
	handler: (_ctx, args) => {
		const parsed: z.output<typeof scalar> = args
		void parsed
		// @ts-expect-error endpoint scalar mask excludes this field
		void args.filters?.secret
		return null
	},
})
auth.authQuery({
	args: relational,
	returns: z.null(),
	handler: (_ctx, args) => {
		const parsed: z.output<typeof relational> = args
		void parsed
		// @ts-expect-error relationship endpoint mask excludes this field
		void args.filters?.parentTask?.secret
		return null
	},
})
const scalarObject: z.ZodObject = scalar
const relationalObject: z.ZodObject = relational
void [scalarObject, relationalObject]
const filter = scalar.shape.filters.unwrap().parse({ parent: 'tasks:1' })
declare const parent: Extract<NonNullable<typeof filter.parent>, string>
const nativeParent: GenericId<'tasks'> = parent
void nativeParent
void parent
// @ts-expect-error a parsed native ID belongs to its table
const wrong: GenericId<'labels'> | undefined = parent
void wrong
const input: z.input<typeof relational> = {
	cursor: null,
	numItems: 1,
	filters: { parent: 'tasks:1' },
}
void input

import type { PaginationFiltersInput } from '../src/relations-public'
const compactScalar = tasks.paginationOpts({ parent: true, title: true }, { validator: 'compact' })
const compactRelation = registry.tables.tasks.paginationOpts(
	{ parentTask: { title: true } },
	{ validator: 'compact' },
)
const deepInput = {
	not: { not: { not: { not: { parent: 'plain-input-string' } } } },
} satisfies PaginationFiltersInput<typeof compactScalar>
void [deepInput, compactRelation]
const badField: PaginationFiltersInput<typeof compactScalar> = {
	// @ts-expect-error only selected fields are allowed
	unknown: 'value',
}
const badDepth: PaginationFiltersInput<typeof compactScalar> = {
	not: {
		not: {
			not: {
				not: {
					// @ts-expect-error four expression edges is the semantic limit
					not: {},
				},
			},
		},
	},
}
const badIdRange: PaginationFiltersInput<typeof compactScalar> = {
	parent: {
		// @ts-expect-error ID predicates do not support ranges
		gt: 'value',
	},
}
void [badField, badDepth, badIdRange]
