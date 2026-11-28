import { k } from 'cvx-kit/k'
import { kTable, kVariantTable } from 'cvx-kit/table'
import { defineRelations } from 'cvx-kit/relations'

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
export const clients = kTable('clients', {
	status: k.string(),
	lifecycleStage: k.enum(stages),
	email: k.string(),
})
export const users = kTable('users', { name: k.string() })
export const contacts = kTable('contacts', { email: k.string(), owner: k.id('users') })
export const ids = kTable('ids', {
	owner: k.id('users'),
	mixed: k.union([k.id('users'), k.string()]),
})
export const events = kVariantTable(
	'events',
	k.discriminatedUnion('kind', [
		k.object({
			kind: k.literal('a'),
			status: k.enum(stages),
			contactId: k.id('contacts'),
			subject: k.string(),
		}),
		k.object({
			kind: k.literal('b'),
			status: k.enum(stages),
			contactId: k.id('contacts'),
			amount: k.number(),
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
