import { k } from 'cvx-kit'
import { kTable } from 'cvx-kit/table'

const Address = k.object({ city: k.string() }).strip()
const Customer = k.object({ name: k.string(), address: Address }).strip()
const Webhook = Customer.extend({ event: k.string() }).strip()
const Args = k.object({ id: k.string() })
const Declared = k.object({ id: k.string() }).strip()
const Exact = k.object({ id: k.string() })

const customers = kTable('customers', { name: k.string() })
const withIndex = { ...customers, table: customers.table.index('by_name', ['name']) }

export function handle(body: string) {
	const event = Webhook.parse(JSON.parse(body))
	return { event, declared: Declared.parse(event), exact: Exact.safeParse(event), withIndex }
}

export const args = { input: Args }
