import { k, kTable } from 'cvx-kit'
import { z } from 'zod'
import { cents as importedCents, debts } from './money'

const cents = k.number().int()
const ledger = kTable('ledger', { amount: cents, memo: k.string() })

export const Positive = cents.nonnegative()
export const Picked = ledger.storage.pick({ amount: true })
export const Fresh = z.object({ total: z.number() }).strict()
export const Unknown = importedCents.strict()
export const UnknownMask = debts.storage.pick({ amount: true }).omit({ memo: true })
