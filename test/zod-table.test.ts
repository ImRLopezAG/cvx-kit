import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import { timestampFields, zodTable } from '../src/zod-table'

const documents = zodTable(
	'documents',
	(id) => ({
		title: z.string(),
		ownerId: id('users'),
		secretNote: z.string(),
		...timestampFields,
	}),
	{
		serverFields: ['createdAt', 'updatedAt'],
		commandFields: ['title'],
		publicFields: ['title', 'ownerId'],
	},
)

describe('zodTable', () => {
	it('removes server-owned fields from the insert boundary', () => {
		expect(Object.keys(documents.insertSchema.shape).sort()).toEqual([
			'ownerId',
			'secretNote',
			'title',
		])
	})

	it('narrows the command boundary to the declared fields', () => {
		expect(Object.keys(documents.commandInput.shape)).toEqual(['title'])
		expect(() =>
			documents.commandInput.parse({ title: 't', secretNote: 'x' }),
		).toThrow()
	})

	it('redacts non-public fields at runtime through toPublicDto', () => {
		const dto = documents.toPublicDto({
			title: 'Quarterly report',
			ownerId: 'users:1' as never,
			secretNote: 'do not leak',
			createdAt: 1,
			updatedAt: 1,
		})
		expect(dto).toEqual({ title: 'Quarterly report', ownerId: 'users:1' })
		expect('secretNote' in dto).toBe(false)
	})

	it('derives update as a partial of insert and supports omit masks', () => {
		expect(documents.updateSchema.parse({})).toEqual({})
		const narrowed = documents.insert({ secretNote: true })
		expect(Object.keys(narrowed.shape).sort()).toEqual(['ownerId', 'title'])
	})

	it('exposes id and update tools bound to the table name', () => {
		expect(Object.keys(documents.tools.update.shape).sort()).toEqual([
			'data',
			'id',
		])
		expect(documents.tableName).toBe('documents')
	})
})
