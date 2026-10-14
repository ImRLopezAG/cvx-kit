import { defineSchema, defineTable } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { v } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import { createTable as rootCreateTable } from '../src/index'
import { createTable, zid, zodToConvex } from '../src/zod-table'

const shared = {
	owner: zid('users'),
	workspace: z
		.string()
		.min(1)
		.refine((value) => value !== 'blocked'),
	note: z.string().optional(),
	secret: z.string(),
}

describe('createTable', () => {
	it('exports the factory from the root and keeps shared fields ordinary by default', () => {
		expect(rootCreateTable).toBe(createTable)
		const customTable = createTable(shared)
		const tasks = customTable('tasks', () => ({ title: z.string() }))
		const issues = customTable('issues', () => ({ severity: z.number() }))
		const row = { owner: zid('users').parse('users:1'), workspace: 'work', secret: 's', title: 't' }
		expect(tasks.insertSchema.parse(row)).toEqual(row)
		expect(tasks.insertSchema.safeParse({ ...row, workspace: 'blocked' }).success).toBe(false)
		expect(tasks.insertSchema.safeParse({ title: 't' }).success).toBe(false)
		expect(tasks.updateSchema.parse({ workspace: 'work', note: 'n' })).toEqual({
			workspace: 'work',
			note: 'n',
		})
		expect(tasks.commandInput.parse({})).toEqual({})
		expect(tasks.toPublicDto(row)).toEqual({})
		expect(issues.storage.shape).not.toHaveProperty('title')
		expect(tasks.storage.shape).not.toHaveProperty('severity')
		expect(shared).not.toHaveProperty('createdAt')
		expect(tasks.storage.shape.owner).toBe(shared.owner)
		expect(tasks.storage.shape.workspace).toBe(shared.workspace)
		expect(tasks.storage.safeParse({ ...row, workspace: 'blocked' }).success).toBe(false)
	})

	it('uses combined fields in allowlists, write masks, DTO extensions, tools and filters', () => {
		const tasks = createTable(shared)(
			'tasks',
			(id) => ({ title: z.string(), parent: id('tasks').optional() }),
			{
				serverFields: ['secret'],
				commandFields: ['workspace', 'note', 'title'],
				publicFields: ['workspace', 'owner', 'title', 'createdAt'],
			},
		)
		const row = {
			owner: zid('users').parse('users:1'),
			workspace: 'work',
			secret: 'hidden',
			title: 't',
			createdAt: 1,
			_id: zid('tasks').parse('tasks:1'),
		}
		expect(tasks.insert({ owner: true }).parse({ workspace: 'work', title: 't' })).toEqual({
			workspace: 'work',
			title: 't',
		})
		expect(tasks.update({ workspace: true }).safeParse({ workspace: 'work' }).success).toBe(false)
		expect(tasks.insertSchema.safeParse(row).success).toBe(false)
		expect(tasks.tools.insert.parse({ workspace: 'work', title: 't' })).toEqual({
			workspace: 'work',
			title: 't',
		})
		expect(tasks.tools.insert.safeParse({ workspace: 'blocked', title: 't' }).success).toBe(false)
		expect(
			tasks.tools.insert.safeParse({ workspace: 'work', title: 't', secret: 's' }).success,
		).toBe(false)
		expect(tasks.tools.update.parse({ id: row._id, data: { note: 'n' } })).toEqual({
			id: row._id,
			data: { note: 'n' },
		})
		expect(
			tasks.tools.update.safeParse({ id: row._id, data: { workspace: 'blocked' } }).success,
		).toBe(false)
		const extend = { label: z.string().min(1) }
		const dto = tasks.toPublicDto(row, { _id: true, extend, values: { label: 'visible' } })
		expect(dto).toEqual({
			owner: row.owner,
			workspace: 'work',
			title: 't',
			createdAt: 1,
			_id: row._id,
			label: 'visible',
		})
		expect(tasks.dto({ _id: true, extend }).parse(dto)).toEqual(dto)
		expect(
			tasks
				.paginationOpts({ workspace: true, owner: true })
				.parse({ numItems: 1, cursor: null, filters: { workspace: 'work', owner: row.owner } })
				.filters,
		).toEqual({ workspace: 'work', owner: row.owner })
	})

	it('persists two independent schemas and uses shared indexes and native ID validation', async () => {
		const customTable = createTable(shared)
		const tasks = customTable(
			'tasks',
			(id) => ({ title: z.string(), parent: id('tasks').optional() }),
			{
				serverFields: ['secret'],
				commandFields: ['workspace', 'owner', 'title'],
				publicFields: ['workspace', 'title'],
			},
		)
		const issues = customTable('issues', () => ({ severity: z.number() }))
		const base = defineTestApp({
			schema: defineSchema({
				users: defineTable({ name: v.string() }),
				tasks: tasks.table.index('by_owner', ['owner']),
				issues: issues.table.index('by_workspace', ['workspace']),
			}),
		})
		const app = base.defineModules({
			functions: {
				create: base.mutation({
					args: zodToConvex(tasks.commandInput),
					handler: async (ctx, args) => {
						const command = tasks.commandInput.parse(args)
						const id = await ctx.db.insert('tasks', { ...command, secret: 'server' })
						const row = await ctx.db.get('tasks', id)
						if (!row) throw new Error('Missing inserted task')
						return tasks.toPublicDto(row, true)
					},
				}),
			},
		})
		const t = app.createTest()
		const [owner, foreign] = await t.run(async (ctx) => [
			await ctx.db.insert('users', { name: 'u' }),
			await ctx.db.insert('issues', {
				owner: await ctx.db.insert('users', { name: 'i' }),
				workspace: 'work',
				secret: 'private',
				severity: 2,
			}),
		])
		const dto = await t.mutation(app.api.functions.create, {
			owner,
			workspace: 'work',
			title: 'task',
		})
		expect(dto).toEqual({ workspace: 'work', title: 'task', _id: dto._id })
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('tasks')
				.withIndex('by_owner', (q) => q.eq('owner', owner))
				.unique()
			expect(row).toMatchObject({ owner, secret: 'server', title: 'task', _id: dto._id })
			expect(tasks.schema.parse(row)).toEqual(row)
			const issue = await ctx.db
				.query('issues')
				.withIndex('by_workspace', (q) => q.eq('workspace', 'work'))
				.unique()
			expect(issue).toMatchObject({ severity: 2, _id: foreign })
		})
		await expect(
			t.mutation(app.api.functions.create, { owner, workspace: 'blocked', title: 'bad' }),
		).rejects.toThrow()
		await expect(
			// @ts-expect-error foreign native IDs must also fail Convex validation
			t.mutation(app.api.functions.create, { owner: foreign, workspace: 'work', title: 'bad' }),
		).rejects.toThrow()
		expect(zodToConvex(tasks.storage.shape.owner)).toMatchObject({ kind: 'id', tableName: 'users' })
		expect(zodToConvex(tasks.schema.shape._id)).toMatchObject({ kind: 'id', tableName: 'tasks' })
		expect(zodToConvex(tasks.storage.shape.parent)).toMatchObject({
			kind: 'id',
			tableName: 'tasks',
			isOptional: 'optional',
		})
	})

	it('rejects duplicate names even for the same validator before merging fields', () => {
		const field = z.string()
		const customTable = createTable({ name: field })
		const dynamic = Object.fromEntries([['name', field]])
		expect(() => customTable('tasks', () => dynamic)).toThrow(/duplicate.*name/i)
		expect(() => customTable('tasks', () => ({ ...dynamic, title: z.string() }))).toThrow(
			/duplicate.*name/i,
		)
		// @ts-expect-error known duplicates are rejected as well as dynamic duplicates
		expect(() => customTable('tasks', () => ({ name: field }))).toThrow(/duplicate.*name/i)
	})

	it('validates combined field lists with the ordinary table rules', () => {
		const customTable = createTable({ secret: z.string(), name: z.string() })
		expect(() =>
			// @ts-expect-error known server-owned command inputs are also rejected statically
			customTable('tasks', () => ({}), { serverFields: ['secret'], commandFields: ['secret'] }),
		).toThrow(/server-owned field/i)
		// @ts-expect-error known unknown field lists are also rejected statically
		expect(() => customTable('tasks', () => ({}), { publicFields: ['missing'] })).toThrow(
			/unknown table field/i,
		)
	})

	it.each(['_id', '_creationTime', 'createdAt', 'updatedAt', 'archivedAt'])(
		'rejects reserved %s in both shapes',
		(key) => {
			expect(() => createTable({ [key]: z.number() })).toThrow(/reserved table field/i)
			expect(() =>
				createTable({ name: z.string() })('tasks', () => ({ [key]: z.number() })),
			).toThrow(/reserved table field/i)
		},
	)
})
