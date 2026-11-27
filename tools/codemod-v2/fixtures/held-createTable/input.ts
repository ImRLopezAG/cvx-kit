import { z } from 'zod'
import { createTable, zodTable } from 'cvx-kit/zod-table'
export const held = createTable({ actor: z.string() })('items', _id => ({ value: z.string().brand<'X'>() }))
export const supported = zodTable('notes', _id => ({ title: z.string() }))
