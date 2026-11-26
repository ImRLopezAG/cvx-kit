import { z } from 'zod'
import { createModule, zodTable } from 'cvx-kit/zod-table'

export const good = zodTable('good', () => ({ name: z.string() }))

export const bad = zodTable('bad', () => ({ pair: z.tuple([z.string()]) }))

export default createModule([good.table, bad.table])
