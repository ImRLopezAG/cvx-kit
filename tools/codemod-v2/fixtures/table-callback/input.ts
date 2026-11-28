import { z } from 'zod'
import { createModule, createTable, paginated, tenantTable, zodTable } from 'cvx-kit/zod-table'

export const users = zodTable(
	'users',
	(id) => ({
		owner: id('users'),
		name: z.string().min(1),
	}),
	{ publicFields: ['name'] },
)

const audited = createTable({ actor: z.string() })

export const notes = audited('notes', (id) => {
	return { user: id('users'), body: z.string() }
})

export const posts = createTable({ slug: z.string() })('posts', () => ({ title: z.string() }))

export const invoices = tenantTable('invoices', (ref) => ({
	customer: ref('customers').optional(),
}))

export const Page = paginated(users.publicDto)

export default createModule([users.table, notes.table])
