import { z } from 'zod'
import { zodTable } from 'cvx-kit/zod-table'
export const table = zodTable('items', _id => ({ value: z.string().brand<'X'>() }))
