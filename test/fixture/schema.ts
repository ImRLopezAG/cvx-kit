import { defineSchema } from 'convex/server'
import { z } from 'zod'
import { zodTable } from '../../src/zod-table'

export const documents = zodTable(
	'documents',
	() => ({
		title: z.string(),
		ownerId: z.string(),
		secretNote: z.string(),
	}),
	{
		commandFields: ['title'],
		publicFields: ['title', 'ownerId'],
	},
)

export const documentHistory = zodTable('documentHistory', () => ({
	documentTitle: z.string(),
	actorId: z.string(),
}))

export default defineSchema({
	documents: documents.table.index('by_owner', ['ownerId']),
	documentHistory: documentHistory.table,
})
