import { z } from 'zod'
import { createModule, kTable } from 'cvx-kit/table'
import { zodTable } from 'cvx-kit/zod-table'
import { k } from 'cvx-kit'

export const good = kTable('good', { name: k.string() })

export const bad = zodTable('bad', () => ({ pair: z.tuple([z.string().optional()]) }))

export default createModule([good.table, bad.table])
