import { kTable } from 'cvx-kit/table'
import { zodTable, paginated } from 'cvx-kit/zod-table'
import { z } from 'zod'

export const done = kTable('done', {})
export const notes = zodTable('notes', () => ({ body: z.string() }))
export const page = paginated(notes.publicDto)
