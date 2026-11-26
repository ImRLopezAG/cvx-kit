import { z } from 'zod'
import { createModule, kTable } from 'cvx-kit/table'
import { k } from 'cvx-kit'

export const good = kTable('good', { name: k.string() })

export const bad = kTable('bad', () => ({ pair: z.tuple([z.string()]) }))

export default createModule([good.table, bad.table])
