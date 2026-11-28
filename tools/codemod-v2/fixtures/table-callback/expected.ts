import { k } from 'cvx-kit'
import { createModule, createTable, paginated, tenantTable, kTable } from 'cvx-kit/table'

export const users = kTable(
	'users',
	{
		owner: k.id('users'),
		name: k.string().min(1),
	},
	{ publicFields: ['name'] },
)

const audited = createTable({ actor: k.string() })

export const notes = audited('notes', { user: k.id('users'), body: k.string() })

export const posts = createTable({ slug: k.string() })('posts', { title: k.string() })

export const invoices = tenantTable('invoices', {
	customer: k.id('customers').optional(),
})

export const Page = paginated(users.publicDto)

export default createModule([users.table, notes.table])
