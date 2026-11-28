import { k } from 'cvx-kit'
import { kTable } from 'cvx-kit/table'

export const orders = kTable('orders', (() => {
	const nested = k.object({ item: k.id('items'), quantity: k.int().positive() })
	const fields = { nested, owner: k.id('users') }
	return fields
})())
