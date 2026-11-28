import { z } from 'zod'
import { kTable } from 'cvx-kit/table'

const Address = z.object({ city: z.string() })
const Customer = z.object({ name: z.string(), address: Address })
const Webhook = Customer.extend({ event: z.string() })
const Args = z.object({ id: z.string() })
const Declared = z.object({ id: z.string() }).strip()
const Exact = z.strictObject({ id: z.string() })

const customers = kTable('customers', { name: z.string() })
const withIndex = { ...customers, table: customers.table.index('by_name', ['name']) }

export function handle(body: string) {
	const event = Webhook.parse(JSON.parse(body))
	return { event, declared: Declared.parse(event), exact: Exact.safeParse(event), withIndex }
}

export const args = { input: Args }
