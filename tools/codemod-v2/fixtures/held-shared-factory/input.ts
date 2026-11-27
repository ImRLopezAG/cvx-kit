import { z } from 'zod'
import { tenantTable } from 'cvx-kit/zod-table'
export const held = tenantTable('items', _id => ({ value: z.string().brand<'X'>() }))
export const supported = tenantTable('notes', _id => ({ title: z.string() }))
