import { zid } from 'convex-helpers/server/zod4'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'
import { z } from 'zod'

import { jsonSafeZid, zodTable } from '../src/zod-table'

const documents = zodTable(
	'documents',
	(id) => ({
		title: z.string(),
		ownerId: id('users'),
		secretNote: z.string(),
	}),
	{
		commandFields: ['title'],
		publicFields: ['title', 'ownerId'],
	},
)

describe('zodTable', () => {
	it('bakes opinionated timestamps into storage', () => {
		expect(Object.keys(documents.storage.shape).sort()).toEqual([
			'archivedAt',
			'createdAt',
			'ownerId',
			'secretNote',
			'title',
			'updatedAt',
		])
	})

	it('always removes timestamps from the insert boundary', () => {
		expect(Object.keys(documents.insertSchema.shape).sort()).toEqual([
			'ownerId',
			'secretNote',
			'title',
		])
	})

	it('allows exposing timestamps through publicFields explicitly', () => {
		const archive = zodTable('archive', () => ({ name: z.string() }), {
			publicFields: ['name', 'createdAt'],
		})
		expect(Object.keys(archive.publicDto.shape).sort()).toEqual(['createdAt', 'name'])
	})

	it('narrows the command boundary to the declared fields', () => {
		expect(Object.keys(documents.commandInput.shape)).toEqual(['title'])
		expect(() => documents.commandInput.parse({ title: 't', secretNote: 'x' })).toThrow()
	})

	it('redacts non-public fields at runtime through toPublicDto', () => {
		const dto = documents.toPublicDto({
			title: 'Quarterly report',
			ownerId: zid('users').parse('users:1'),
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
		expect(Object.keys(documents.tools.update.shape).sort()).toEqual(['data', 'id'])
		expect(documents.tableName).toBe('documents')
	})
})

describe('jsonSafeZid', () => {
	it('validates primitive ids while retaining the owning table type', () => {
		const schema = jsonSafeZid('documents')
		expect(schema.safeParse('').success).toBe(zid('documents').safeParse('').success)
		expect(schema.safeParse(42).success).toBe(false)
		expect(schema.parse('documents:1')).toBe('documents:1')
		expectTypeOf<z.output<typeof schema>>().toEqualTypeOf<
			import('convex/values').GenericId<'documents'>
		>()
		expect(z.toJSONSchema(schema)).toMatchObject({ type: 'string' })
	})
})
