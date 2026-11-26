import { defineSchema } from 'convex/server'
import { k } from '../../src/k'
import { kTable } from '../../src/table'

export const documents = kTable(
	'documents',
	{
		title: k.string(),
		ownerId: k.string(),
		secretNote: k.string(),
	},
	{
		commandFields: ['title'],
		publicFields: ['title', 'ownerId'],
	},
)

export const documentHistory = kTable('documentHistory', {
	documentTitle: k.string(),
	actorId: k.string(),
})

export default defineSchema({
	documents: documents.table.index('by_owner', ['ownerId']),
	documentHistory: documentHistory.table,
})
