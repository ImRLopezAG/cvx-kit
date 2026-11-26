import { kTable, paginated } from 'cvx-kit/table'
import { k } from 'cvx-kit'

export const done = kTable('done', {})
export const notes = kTable('notes', { body: k.string() })
export const page = paginated(notes.publicDto)
