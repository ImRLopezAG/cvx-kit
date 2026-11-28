import { z } from 'zod'
import { tenantTable as tenantTableV2 } from 'cvx-kit/table'
import { tenantTable } from 'cvx-kit/zod-table'
import { k } from 'cvx-kit'
export const held = tenantTable('items', _id => ({ value: z.string().brand<'X'>() }))
export const supported = tenantTableV2('notes', { title: k.string() })
