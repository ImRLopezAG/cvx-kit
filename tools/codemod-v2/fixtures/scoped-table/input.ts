import { z } from 'zod'
import { zodTable } from 'cvx-kit/zod-table'

export const orders = zodTable('orders', (id) => {
	const nested = z.object({ item: id('items'), quantity: z.int().positive() })
	const fields = { nested, owner: id('users') }
	return fields
})
