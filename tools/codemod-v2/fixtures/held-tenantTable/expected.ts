import { z } from 'zod'
import { kTable } from 'cvx-kit/table'
import { tenantTable } from 'cvx-kit/zod-table'
import { k } from 'cvx-kit'
export const held = tenantTable('items', _id => ({ value: z.string().brand<'X'>() }))
export const supported = kTable('notes', { title: k.string() })
