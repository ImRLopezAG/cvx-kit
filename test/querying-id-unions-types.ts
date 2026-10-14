import { expectTypeOf } from 'vite-plus/test'
import type { GenericId } from 'convex/values'
import { z } from 'zod'
import { defineRelations, type FieldReference } from '../src/relations-public'
import { zodTable } from '../src/zod-table'
import { idUnionFixture, idUnionTables } from './fixture-querying/id-unions'

const f = idUnionFixture()
const dto = f.relations.tables.tasks.pageDto({
	referenceTask: true,
	referencingTasks: true,
	client: true,
	payment: true,
	postedPayment: true,
	ledgerEntry: true,
})
type Row = z.output<typeof dto>['page'][number]
expectTypeOf<Row['rel']>().toEqualTypeOf<
	| GenericId<'tasks'>
	| GenericId<'leads'>
	| GenericId<'contacts'>
	| GenericId<'clients'>
	| GenericId<'creditors'>
	| GenericId<'deals'>
	| GenericId<'payments'>
	| GenericId<'ledger'>
	| null
	| undefined
>()
expectTypeOf<NonNullable<Row['referenceTask']>['_id']>().toEqualTypeOf<GenericId<'tasks'>>()
expectTypeOf<Row['referencingTasks']['page'][number]['_id']>().toEqualTypeOf<GenericId<'tasks'>>()
expectTypeOf<NonNullable<Row['client']>['_id']>().toEqualTypeOf<GenericId<'clients'>>()
expectTypeOf<NonNullable<Row['payment']>['type']>().toEqualTypeOf<'posted' | 'draft'>()
expectTypeOf<NonNullable<Row['postedPayment']>['type']>().toEqualTypeOf<'posted'>()
expectTypeOf<NonNullable<Row['ledgerEntry']>['type']>().toEqualTypeOf<'debit' | 'credit'>()
// SAFETY: compile-only probe of the inferred DTO; no value reaches execution.
// @ts-expect-error private fields stay out of hydrated DTOs
void ({} as NonNullable<Row['client']>).secret
// @ts-expect-error undeclared relations cannot be selected
f.relations.tables.tasks.pageDto({ unknown: true })
// @ts-expect-error private scalar is not an output relation
f.relations.tables.tasks.pageDto({ secret: true })
// @ts-expect-error invalid relation filter mask
f.relations.tables.tasks.paginationOpts({ client: { unknown: true } })

defineRelations(idUnionTables(), (r, branch) => {
	const selected = r.tasks.rel.forTable('clients')
	type Selected =
		typeof selected extends FieldReference<string, string, infer V, never, any, any> ? V : never
	expectTypeOf<Selected>().toEqualTypeOf<GenericId<'clients'> | null | undefined>()
	selected.forTable('clients')
	// @ts-expect-error repeated selection cannot widen to another member
	selected.forTable('tasks')
	// @ts-expect-error undeclared member
	r.tasks.rel.forTable('unknown')
	// @ts-expect-error non-ID field
	r.tasks.status.forTable('tasks')
	// @ts-expect-error scoped member narrowing is explicitly deferred
	branch('payments', 'posted').clientId.forTable('clients')
	// @ts-expect-error narrowed base cannot enter a junction
	selected.through(r.clients._id)
	// @ts-expect-error narrowed junction is explicitly deferred
	r.clients._id.through(selected)
	return {
		tasks: {
			// @ts-expect-error selected client ID cannot join task ID
			wrong: r.one.tasks({ from: selected, to: r.tasks._id }),
		},
	}
})
const tasks = zodTable('tasks', (id) => ({
	rel: z.union([id('tasks'), id('missing')]).optional(),
	mixed: z.union([id('tasks'), z.string()]),
	nil: z.null(),
	single: id('tasks').nullable().optional(),
	duplicate: z.union([id('tasks'), id('tasks')]),
}))
defineRelations({ tasks }, (r) => {
	// @ts-expect-error declared but unregistered member
	r.tasks.rel.forTable('missing')
	// @ts-expect-error mixed scalar-ID domain
	r.tasks.mixed.forTable('tasks')
	// @ts-expect-error null-only domain
	r.tasks.nil.forTable('tasks')
	return {
		tasks: {
			singleLink: r.one.tasks({ from: r.tasks.single.forTable('tasks'), to: r.tasks._id }),
			duplicateLink: r.one.tasks({ from: r.tasks.duplicate.forTable('tasks'), to: r.tasks._id }),
		},
	}
})
