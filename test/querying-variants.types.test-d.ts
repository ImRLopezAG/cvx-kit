import type { GenericId } from 'convex/values'
import type { DataModelFromSchemaDefinition } from 'convex/server'
import type { ManagedQueryContext } from '../src/querying/security'
import { z } from 'zod'
import { zid } from 'convex-helpers/server/zod4'
import { defineRelations } from '../src/relations-public'
import { zodVariantTable } from '../src/zod-table'
import { variantDeclarations, variantFixture } from './fixture-querying/variants'

const f = variantFixture()
const scalarVariants = zodVariantTable(
	'scalarVariants',
	z.discriminatedUnion('type', [
		z.strictObject({ type: z.literal('a'), variants: z.string(), value: z.number() }),
		z.strictObject({ type: z.literal('b'), variants: z.string(), label: z.string() }),
	]),
	{
		discriminator: 'type',
		variants: {
			a: { publicFields: ['variants', 'value'] },
			b: { publicFields: ['variants', 'label'] },
		},
	},
)
const scalarRelations = defineRelations({ scalarVariants }, () => ({}))
scalarRelations.tables.scalarVariants.paginationOpts({ variants: true })
scalarRelations.tables.scalarVariants.paginationOpts({
	variants: { a: { value: true }, b: { label: true } },
})
const single = zodVariantTable(
	'single',
	z.discriminatedUnion('type', [z.strictObject({ type: z.literal('a'), value: z.number() })]),
	{ discriminator: 'type', variants: { a: { publicFields: ['value'] } } },
)
defineRelations({ single }, () => ({})).tables.single.paginationOpts({
	variants: { a: { value: true } },
})
declare const ctx: ManagedQueryContext<DataModelFromSchemaDefinition<typeof f.schema>>
declare const clientId: GenericId<'clients'>
declare const creditorId: GenericId<'creditors'>
declare const paymentId: GenericId<'payments'>
const q = f.querying(ctx)
q.payments.where({ variant: { tag: 'creditor_payment', filters: { creditorId } } })
q.payments.where({
	or: [
		{ variant: { tag: 'client_draft', filters: { draftDate: { gte: 0 } } } },
		{ type: 'creditor_payment' },
	],
})
q.payments
	.with({ client: true, creditor: true, attachments: true })
	.paginate({ numItems: 2, cursor: null })
	.then((result) => {
		for (const row of result.page) {
			const id: GenericId<'payments'> = row._id
			const client: GenericId<'clients'> | undefined = row.client?._id
			const attachment: GenericId<'attachments'> = row.attachments.page[0]._id
			void [id, client, attachment]
			if (row.type === 'creditor_payment') {
				const creditor: GenericId<'creditors'> = row.creditorId
				void creditor
				// @ts-expect-error draft field is absent in creditor branch
				void row.draftDate
			} else {
				const date: number = row.draftDate
				void date
				// @ts-expect-error creditor key is absent in draft branch
				void row.creditorId
			}
			// @ts-expect-error private processor evidence never enters DTO
			void row.external
			// @ts-expect-error server-managed timestamp omitted from public mask
			void row.createdAt
		}
	})
q.clients
	.with({ payments: { creditor: true } })
	.paginate({ numItems: 1, cursor: null })
	.then((result) => {
		const row = result.page[0].payments.page[0]
		if (row.type === 'creditor_payment') {
			const id: GenericId<'creditors'> = row.creditorId
			void id
		} else {
			const date: number = row.draftDate
			void date
			// @ts-expect-error nested selections preserve branch exclusion
			void row.creditorId
		}
	})
q.creditors
	.relation(creditorId, 'payments')
	.with({ client: true })
	.paginate({ numItems: 1, cursor: null })
	.then((result) => {
		const row = result.page[0]
		const tag: 'creditor_payment' = row.type
		const creditor: GenericId<'creditors'> = row.creditorId
		void [tag, creditor]
		// @ts-expect-error target branch guard excludes draft fields
		void row.draftDate
	})
q.payments.relation(paymentId, 'attachments').paginate({ numItems: 1, cursor: null })
q.creditors
	.with({ payments: true })
	.paginate({ numItems: 1, cursor: null })
	.then((result) => {
		const row = result.page[0].payments.page[0]
		const tag: 'creditor_payment' = row.type
		const id: GenericId<'creditors'> = row.creditorId
		void [tag, id]
	})
const input = f.relations.tables.payments.paginationOpts({
	type: true,
	clientId: true,
	variants: { creditor_payment: { creditorId: true }, client_draft: { draftDate: true } },
})
const filters: NonNullable<z.input<typeof input>['filters']> = {
	variant: { tag: 'creditor_payment', filters: { creditorId } },
}
void filters
// @ts-expect-error branch-only predicates require explicit scope
q.payments.where({ creditorId })
// @ts-expect-error implicit tag sibling does not guard a branch-only predicate
q.payments.where({ type: 'creditor_payment', creditorId })
// @ts-expect-error unknown branch tag
q.payments.where({ variant: { tag: 'unknown', filters: {} } })
// @ts-expect-error mismatched branch field
q.payments.where({ variant: { tag: 'client_draft', filters: { creditorId } } })
// @ts-expect-error foreign native ID brand
q.payments.where({ variant: { tag: 'creditor_payment', filters: { creditorId: clientId } } })
// @ts-expect-error private fields cannot be filtered by client query
q.payments.where({ external: { providerId: 'private' } })
// @ts-expect-error private field cannot be included in filter mask
f.relations.tables.payments.paginationOpts({ external: true })
// @ts-expect-error branch private mask does not become public
f.relations.tables.payments.paginationOpts({ variants: { creditor_payment: { external: true } } })
// @ts-expect-error branch-only masks require scope
f.relations.tables.payments.paginationOpts({ creditorId: true })
// @ts-expect-error branch masks cannot include another branch field
f.relations.tables.payments.paginationOpts({ variants: { client_draft: { creditorId: true } } })
// @ts-expect-error unknown mask tag
f.relations.tables.payments.paginationOpts({ variants: { unknown: {} } })
// @ts-expect-error private field cannot be selected as output relation
q.payments.with({ external: true })
// @ts-expect-error wrong parent ID brand
q.payments.relation(clientId, 'attachments')

const tables = variantDeclarations()
defineRelations(tables, (r) => ({
	payments: {
		// @ts-expect-error variant predicate name is reserved on variant tables
		variant: r.one.clients({ from: r.payments.clientId, to: r.clients._id }),
	},
}))
defineRelations(tables, (r) => ({
	payments: {
		// @ts-expect-error variants mask name is reserved on variant tables
		variants: r.one.clients({ from: r.payments.clientId, to: r.clients._id }),
	},
}))
const ordinaryNames = defineRelations(tables, (r) => ({
	clients: {
		variant: r.many.payments({ from: r.clients._id, to: r.payments.clientId }),
		variants: r.many.payments({ from: r.clients._id, to: r.payments.clientId }),
	},
}))
ordinaryNames.tables.clients.paginationOpts({
	variant: { amountCents: true },
	variants: { amountCents: true },
})
ordinaryNames.tables.clients.pageDto({ variant: true, variants: true })
defineRelations(tables, (r, branch) => {
	// @ts-expect-error object tables have no branch scope
	branch('clients', 'client_draft')
	// @ts-expect-error unknown variant scope
	branch('payments', 'unknown')
	// @ts-expect-error branch field is not a common field
	void r.payments.creditorId
	// @ts-expect-error field belongs to a different branch
	void branch('payments', 'client_draft').creditorId
	return {
		payments: {
			// @ts-expect-error creditor key cannot join to client ID
			wrong: r.one.clients({
				from: branch('payments', 'creditor_payment').creditorId,
				to: r.clients._id,
			}),
		},
	}
})
const mixed = zodVariantTable(
	'mixed',
	z.discriminatedUnion('type', [
		z.strictObject({ type: z.literal('a'), ref: zid('clients') }),
		z.strictObject({ type: z.literal('b'), ref: zid('creditors') }),
	]),
	{
		discriminator: 'type',
		variants: { a: { publicFields: ['ref'] }, b: { publicFields: ['ref'] } },
	},
)
defineRelations({ ...tables, mixed }, (r) => {
	// @ts-expect-error same name with incompatible ID brands is not a common field
	void r.mixed.ref
	return {}
})
