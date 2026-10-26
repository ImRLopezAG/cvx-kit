import { z } from 'zod'
import { zodTable, zodVariantTable } from 'cvx-kit/zod-table'
import { defineRelations } from 'cvx-kit/relations'
import { zid } from 'convex-helpers/server/zod4'

export const stages = [
	's0',
	's1',
	's2',
	's3',
	's4',
	's5',
	's6',
	's7',
	's8',
	's9',
	's10',
	's11',
	's12',
] as const
export const clients = zodTable('clients', () => ({
	status: z.string(),
	lifecycleStage: z.enum(stages),
	email: z.string(),
}))
export const users = zodTable('users', () => ({ name: z.string() }))
export const contacts = zodTable('contacts', () => ({ email: z.string(), owner: zid('users') }))
export const ids = zodTable('ids', () => ({
	owner: zid('users'),
	mixed: z.union([zid('users'), z.string()]),
}))
export const events = zodVariantTable(
	'events',
	z.discriminatedUnion('kind', [
		z.strictObject({
			kind: z.literal('a'),
			status: z.enum(stages),
			contactId: zid('contacts'),
			subject: z.string(),
		}),
		z.strictObject({
			kind: z.literal('b'),
			status: z.enum(stages),
			contactId: zid('contacts'),
			amount: z.number(),
		}),
	]),
	{
		discriminator: 'kind',
		variants: {
			a: { publicFields: ['status', 'contactId', 'subject'] },
			b: { publicFields: ['status', 'contactId', 'amount'] },
		},
	},
)
export const relations = defineRelations({ clients, contacts, events, users, ids }, (r) => ({
	events: {
		contact: r.one.contacts({ from: r.events.contactId, to: r.contacts._id }),
		contacts: r.many.contacts({ from: r.events.contactId, to: r.contacts._id }),
	},
}))
export const scalarOptions = clients.paginationOpts(
	{ status: true, lifecycleStage: true, email: true },
	{ validator: 'compact' },
)
export const relationOptions = relations.tables.events.paginationOpts(
	{
		status: true,
		contact: { email: true },
		contacts: { email: true },
		variants: { a: { subject: true }, b: { amount: true } },
	},
	{ validator: 'compact' },
)
export const idOptions = ids.paginationOpts({ owner: true, mixed: true }, { validator: 'compact' })
export const variantIdOptions = relations.tables.events.paginationOpts(
	{
		contact: { owner: true },
		contacts: { owner: true },
		variants: { a: { contactId: true }, b: { contactId: true } },
	},
	{ validator: 'compact' },
)
