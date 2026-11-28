import { z } from 'zod'
import { zodVariantTable, zodTable } from 'cvx-kit/zod-table'
export const held = zodVariantTable('items', _id => ({ value: z.string().brand<'X'>() }))
export const supported = zodTable('notes', _id => ({ title: z.string() }))
