import { k, kTable } from 'cvx-kit'
import { cents as importedCents, debts } from './money'

const cents = k.number().int()
const ledger = kTable('ledger', { amount: cents, memo: k.string() })

export const Positive = cents.nonnegative()
export const Picked = ledger.storage.pick('amount')
export const Fresh = k.object({ total: k.number().finite() }).strict()
export const Unknown = importedCents.strict()
export const UnknownMask = debts.storage.pick({ amount: true }).omit({ memo: true })
