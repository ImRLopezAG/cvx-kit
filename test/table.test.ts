import { defineSchema, defineTable } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { v, type GenericId } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'

import { k, KValidationError } from '../src/k'
import { toJsonSchema } from '../src/json-schema'
import { createTable, kTable, tenantTable, TIMESTAMP_FIELDS } from '../src/table'
import * as namespaces from '../src/namespace'
import * as root from '../src/index'
import * as v2 from '../src/table'

/** A typed id for test rows; ids are strings at runtime. */
function idOf<Table extends string>(table: Table, value: string): GenericId<Table> {
	return k.id(table).parse(value)
}

const documents = kTable(
	'documents',
	{ title: k.string(), ownerId: k.id('users'), secretNote: k.string() },
	{ commandFields: ['title'], publicFields: ['title', 'ownerId'] },
)

const row = {
	title: 'Quarterly report',
	ownerId: idOf('users', 'users:1'),
	secretNote: 'do not leak',
	_id: idOf('documents', 'documents:1'),
	_creationTime: 12,
}

describe('kTable boundaries', () => {
	it('bakes the optional timestamps into storage and removes them from every write input', () => {
		expect(Object.keys(documents.storage.shape)).toEqual([
			'title',
			'ownerId',
			'secretNote',
			...TIMESTAMP_FIELDS,
		])
		expect(Object.keys(documents.insertSchema.shape)).toEqual(['title', 'ownerId', 'secretNote'])
		expect(Object.keys(documents.schema.shape)).toEqual([
			...Object.keys(documents.storage.shape),
			'_id',
			'_creationTime',
		])
		for (const key of TIMESTAMP_FIELDS)
			expect(documents.storage.shape[key].validator.isOptional).toBe('optional')
		expect(documents.tableName).toBe('documents')
	})

	it('narrows commands to commandFields, strictly', () => {
		expect(Object.keys(documents.commandInput.shape)).toEqual(['title'])
		expect(() => documents.commandInput.parse({ title: 't', secretNote: 'x' })).toThrow(
			KValidationError,
		)
	})

	it('allows exposing timestamps through publicFields explicitly', () => {
		const archive = kTable('archive', { name: k.string() }, { publicFields: ['name', 'createdAt'] })
		expect(Object.keys(archive.publicDto.shape)).toEqual(['name', 'createdAt'])
	})

	it('updateSchema is the partial of insertSchema: checks kept, no default filled', () => {
		const notes = kTable('notes', {
			title: k.string().min(2),
			state: k.enum(['draft', 'published']).default('draft'),
		})
		expect(notes.updateSchema.parse({})).toEqual({})
		expect(notes.updateSchema.parse({ title: 'ok' })).toEqual({ title: 'ok' })
		expect(notes.updateSchema.safeParse({ title: 'x' }).success).toBe(false)
		expect(notes.insertSchema.parse({ title: 'ok' })).toEqual({ title: 'ok', state: 'draft' })
		expect(notes.updateSchema.shape.title.unwrap()).toBe(notes.insertSchema.shape.title)
		expect(notes.updateSchema.validator.fields.title.isOptional).toBe('optional')
	})

	it('insert(...omit) and update(...omit) drop fields per call site', () => {
		expect(Object.keys(documents.insert('secretNote').shape)).toEqual(['title', 'ownerId'])
		expect(documents.insert()).toBe(documents.insertSchema)
		expect(Object.keys(documents.update('title').shape)).toEqual(['ownerId', 'secretNote'])
		expect(documents.update()).toBe(documents.updateSchema)
	})

	it('exposes id and update tools bound to the table name, with ids as strings in JSON Schema', () => {
		expect(Object.keys(documents.tools.update.shape)).toEqual(['data', 'id'])
		expect(documents.tools.insert).toBe(documents.commandInput)
		expect(documents.tools.id.validator.fields.id).toMatchObject({
			kind: 'id',
			tableName: 'documents',
		})
		expect(toJsonSchema(documents.tools.update)).toMatchObject({
			properties: { id: { type: 'string' } },
		})
		expect(documents.tools.update.parse({ id: row._id, data: {} })).toEqual({
			id: row._id,
			data: {},
		})
	})
})

describe('kTable public DTOs (R16, AE7)', () => {
	it('drops non-public fields at runtime', () => {
		const dto = documents.toPublicDto({ ...row, createdAt: 1, updatedAt: 1 })
		expect(dto).toEqual({ title: row.title, ownerId: row.ownerId })
		expect('secretNote' in dto).toBe(false)
	})

	it('throws when the projection still holds a key outside the public shape', () => {
		const nested = kTable(
			'nested',
			{ profile: k.object({ name: k.string() }), secret: k.string() },
			{ publicFields: ['profile'] },
		)
		expect(nested.toPublicDto({ profile: { name: 'n' }, secret: 's' })).toEqual({
			profile: { name: 'n' },
		})
		expect(() =>
			// SAFETY: deliberately smuggle a non-public key inside a public object.
			nested.toPublicDto({ profile: { name: 'n', secret: 's' } as never, secret: 's' }),
		).toThrow(KValidationError)
	})

	it('throws when a required public field is missing or mistyped', () => {
		// SAFETY: deliberately pass rows the declared row type forbids.
		expect(() => documents.toPublicDto({ ownerId: row.ownerId } as never)).toThrow(KValidationError)
		// SAFETY: deliberately pass rows the declared row type forbids.
		expect(() => documents.toPublicDto({ ...row, title: 1 } as never)).toThrow(KValidationError)
	})

	it('adds only a validated id when requested', () => {
		const shorthand = documents.toPublicDto(row, true)
		expect(shorthand).toEqual({ title: row.title, ownerId: row.ownerId, _id: row._id })
		expect(documents.dto(true).parse(shorthand)).toEqual(shorthand)
		expect(documents.toPublicDto(row, { _id: true })).toEqual(shorthand)
		expect(documents.dto({ _id: true }).parse(shorthand)).toEqual(shorthand)
		expect(documents.toPublicDto(row, false)).toEqual(documents.toPublicDto(row))
		expect(documents.toPublicDto(row, {})).toEqual(documents.toPublicDto(row))
		expect(documents.dto()).toBe(documents.publicDto)
		expect(documents.dto(false)).toBe(documents.publicDto)
		expect(documents.dto(true)).toBe(documents.dto(true))
		expect(documents.publicDto.safeParse(shorthand).success).toBe(false)
		expect(documents.dto(true).validator.fields._id).toMatchObject({
			kind: 'id',
			tableName: 'documents',
		})
	})

	it('rejects a missing or non-string id only when requested', () => {
		const { _id, ...withoutId } = row
		void _id
		// @ts-expect-error requested ids require an id-bearing row
		expect(() => documents.toPublicDto(withoutId, true)).toThrow(KValidationError)
		// @ts-expect-error ids must be strings
		expect(() => documents.toPublicDto({ ...row, _id: 42 }, { _id: true })).toThrow()
		expect(documents.toPublicDto(withoutId)).toEqual({ title: row.title, ownerId: row.ownerId })
	})

	it('validates extension values with the matching strict return schema', () => {
		const extend = {
			url: k.string().regex(/^https:\/\//),
			length: k.int().refine((value) => value > 0),
		}
		const dto = documents.toPublicDto(row, {
			_id: true,
			extend,
			values: { url: 'https://example.com', length: 3 },
		})
		expect(dto).toEqual({
			title: row.title,
			ownerId: row.ownerId,
			_id: row._id,
			url: 'https://example.com',
			length: 3,
		})
		const result = documents.dto({ _id: true, extend })
		expect(result.parse(dto)).toEqual(dto)
		expect(result.safeParse({ ...dto, secretNote: 'leak' }).success).toBe(false)
		expect(() =>
			documents.toPublicDto(row, { extend, values: { url: 'invalid', length: 3 } }),
		).toThrow(KValidationError)
		// @ts-expect-error extension values are required
		expect(() => documents.toPublicDto(row, { extend })).toThrow()
		expect(() =>
			documents.toPublicDto(row, {
				extend,
				// @ts-expect-error extension values are a strict object
				values: { url: 'https://example.com', length: 3, title: 'overwrite' },
			}),
		).toThrow()
	})

	it('rejects value-changing extension schemas', () => {
		const unsupported = [
			k.string().trim(),
			k.string().toLowerCase(),
			k.string().overwrite((value) => value),
			k.string().default('filled'),
			k.object({ nested: k.string().trim() }),
			k.array(k.string().default('x')),
			k.union([k.string(), k.number().default(1)]),
			k.record(k.string(), k.string().trim()),
		]
		for (const field of unsupported) {
			const extend = { extra: field }
			expect(() => documents.dto({ extend })).toThrow(/value-preserving/i)
			expect(() =>
				// SAFETY: extension values are irrelevant; the schema is rejected first.
				documents.toPublicDto(row, { extend, values: { extra: 'abc' } as never }),
			).toThrow(/value-preserving/i)
		}
	})

	it('rejects projected and reserved extension collisions', () => {
		for (const key of [
			'title',
			'ownerId',
			'_id',
			'_creationTime',
			'createdAt',
			'updatedAt',
			'archivedAt',
			'tenant',
			'__proto__',
		]) {
			const extend = Object.fromEntries([[key, k.string()]])
			expect(() => documents.dto({ extend })).toThrow(/collision/i)
			expect(() =>
				documents.toPublicDto(row, { extend, values: Object.fromEntries([[key, 'x']]) }),
			).toThrow(/collision/i)
		}
	})

	it('keeps missing optional public fields as undefined keys', () => {
		const notes = kTable(
			'notes',
			{ text: k.string().optional(), secret: k.string() },
			{
				publicFields: ['text'],
			},
		)
		const dto = notes.toPublicDto({ secret: 'hidden' })
		expect(dto).toEqual({ text: undefined })
		expect(Object.keys(dto)).toEqual(['text'])
		const extend = { url: k.string().optional() }
		const extended = notes.toPublicDto({ secret: 'hidden' }, { extend, values: {} })
		expect(extended).toEqual({ text: undefined })
		expect(notes.dto({ extend }).parse(extended)).toEqual(extended)
	})

	it('validates nested refinements and optionals against the actual projector output', () => {
		const extend = {
			extra: k.object({
				name: k
					.string()
					.min(1)
					.refine((value) => value !== 'hidden'),
				note: k.string().optional(),
			}),
		}
		const dto = documents.toPublicDto(row, { extend, values: { extra: { name: 'visible' } } })
		expect(documents.dto({ extend }).parse(dto)).toEqual(dto)
		expect(() =>
			documents.toPublicDto(row, { extend, values: { extra: { name: 'hidden' } } }),
		).toThrow(KValidationError)
		expect(() =>
			// @ts-expect-error extension values require an explicit schema
			documents.toPublicDto(row, { values: { url: 'https://example.com' } }),
		).toThrow()
	})
})

describe('kTable field rules (KTD4, R17)', () => {
	it('AE1: a defaulted field is optional on insert and storage, filled on write and projection', () => {
		const reviewed = kTable(
			'reviewed',
			{ title: k.string(), reviewState: k.enum(['draft', 'published']).default('draft') },
			{ commandFields: ['title', 'reviewState'], publicFields: ['title', 'reviewState'] },
		)
		expect(reviewed.commandInput.parse({ title: 't' })).toEqual({
			title: 't',
			reviewState: 'draft',
		})
		expect(reviewed.storage.validator.fields.reviewState.isOptional).toBe('optional')
		expect(reviewed.commandInput.validator.fields.reviewState.isOptional).toBe('optional')
		expect(reviewed.publicDto.outputValidator.fields.reviewState.isOptional).toBe('required')
		expect(reviewed.dto(true).outputValidator.fields.reviewState.isOptional).toBe('required')
		expect(reviewed.toPublicDto({ title: 't' })).toEqual({ title: 't', reviewState: 'draft' })
		expect(reviewed.toPublicDto({ title: 't', reviewState: 'published' })).toEqual({
			title: 't',
			reviewState: 'published',
		})
	})

	it('AE2: a transform or pipe field throws at definition, naming the field', () => {
		expect(() =>
			kTable('bad', {
				ok: k.string(),
				// @ts-expect-error a transform field is rejected in types too
				count: k.string().transform((value) => value.length),
			}),
		).toThrow(/"count".*transform or pipe/)
		expect(() =>
			// @ts-expect-error a pipe field is rejected in types too
			kTable('bad', { piped: k.string().pipe(k.string().min(1)) }),
		).toThrow(/"piped"/)
		expect(() =>
			// @ts-expect-error a nested transform is rejected in types too
			kTable('bad', { nested: k.object({ inner: k.string().transform(Number) }) }),
		).toThrow(/"nested"/)
		expect(() =>
			// @ts-expect-error shared fields follow the same rule
			createTable({ size: k.string().transform((value) => value.length) }),
		).toThrow(/"size"/)
	})

	it('AE3: a trimmed field stores the trimmed value; projection runs no normaliser', () => {
		const titled = kTable(
			'titled',
			{ title: k.string().trim() },
			{ commandFields: ['title'], publicFields: ['title'] },
		)
		expect(titled.commandInput.parse({ title: '  Plan  ' })).toEqual({ title: 'Plan' })
		expect(titled.toPublicDto({ title: '  stored  ' })).toEqual({ title: '  stored  ' })
	})

	it('projection does not re-run checks on stored values', () => {
		const checked = kTable('checked', { code: k.string().min(5) }, { publicFields: ['code'] })
		expect(checked.toPublicDto({ code: 'abc' })).toEqual({ code: 'abc' })
	})

	it('rejects reserved declarations, unknown names and server-owned commands', () => {
		for (const key of ['_id', '_creationTime', 'createdAt', 'updatedAt', 'archivedAt']) {
			expect(() => kTable('invalid', Object.fromEntries([[key, k.string()]]))).toThrow(
				/reserved table field/i,
			)
		}
		expect(() =>
			kTable(
				'invalid',
				{ secret: k.string() },
				// @ts-expect-error server-owned fields cannot enter commands
				{ serverFields: ['secret'], commandFields: ['secret'] },
			),
		).toThrow(/server-owned field/i)
		for (const options of [
			{ publicFields: ['missing'] },
			{ serverFields: ['missing'] },
			{ commandFields: ['missing'] },
			{ commandFields: ['createdAt'] },
		]) {
			// SAFETY: deliberate JS bypass exercises the field-list checks.
			expect(() => kTable('invalid', { name: k.string() }, options as never)).toThrow()
		}
	})
})

describe('tenantTable', () => {
	it('adds a required, server-owned tenant field excluded from writes', () => {
		const items = tenantTable(
			'items',
			{ name: k.string() },
			{ commandFields: ['name'], publicFields: ['name'] },
		)
		expect(Object.keys(items.storage.shape)).toEqual(['name', 'tenant', ...TIMESTAMP_FIELDS])
		expect(items.storage.validator.fields.tenant.isOptional).toBe('required')
		expect(items.storage.safeParse({ name: 'n', tenant: '' }).success).toBe(false)
		expect(Object.keys(items.insertSchema.shape)).toEqual(['name'])
		expect(items.insertSchema.safeParse({ name: 'n', tenant: 't' }).success).toBe(false)
		expect(items.toPublicDto({ name: 'n', tenant: 't' })).toEqual({ name: 'n' })
	})

	it('rejects a declared tenant and tenant in commandFields', () => {
		// @ts-expect-error tenant is injected and cannot be redeclared
		expect(() => tenantTable('invalid', { tenant: k.string() })).toThrow(/tenant/i)
		for (const options of [
			{ publicFields: ['missing'] },
			{ commandFields: ['createdAt'] },
			{ commandFields: ['tenant'] },
		]) {
			// SAFETY: deliberate JS bypass exercises the field-list checks.
			expect(() => tenantTable('invalid', { name: k.string() }, options as never)).toThrow()
		}
		const valid = tenantTable(
			'valid',
			{ name: k.string() },
			{ publicFields: ['tenant', 'createdAt'] },
		)
		expect(valid.publicDto.parse({ tenant: 't', createdAt: 1 })).toEqual({
			tenant: 't',
			createdAt: 1,
		})
		expect(valid.commandInput.parse({})).toEqual({})
	})

	it('infers extra serverFields', () => {
		const approvals = tenantTable(
			'approvals',
			{ name: k.string(), approver: k.id('users') },
			{ serverFields: ['approver'], commandFields: ['name'], publicFields: ['tenant'] },
		)
		expect(Object.keys(approvals.insertSchema.shape)).toEqual(['name'])
	})
})

const shared = {
	owner: k.id('users'),
	workspace: k
		.string()
		.min(1)
		.refine((value) => value !== 'blocked'),
	note: k.string().optional(),
	secret: k.string(),
}

describe('createTable', () => {
	it('is re-exported from the table entry and keeps shared fields ordinary by default', () => {
		expect(root.createTable).toBe(createTable)
		const customTable = createTable(shared)
		const tasks = customTable('tasks', { title: k.string() })
		const issues = customTable('issues', { severity: k.number() })
		const task = { owner: idOf('users', 'users:1'), workspace: 'work', secret: 's', title: 't' }
		expect(tasks.insertSchema.parse(task)).toEqual(task)
		expect(tasks.insertSchema.safeParse({ ...task, workspace: 'blocked' }).success).toBe(false)
		expect(tasks.insertSchema.safeParse({ title: 't' }).success).toBe(false)
		expect(tasks.updateSchema.parse({ workspace: 'work', note: 'n' })).toEqual({
			workspace: 'work',
			note: 'n',
		})
		expect(tasks.commandInput.parse({})).toEqual({})
		expect(tasks.toPublicDto(task)).toEqual({})
		expect(issues.storage.shape).not.toHaveProperty('title')
		expect(tasks.storage.shape).not.toHaveProperty('severity')
		expect(tasks.storage.shape.owner).toBe(shared.owner)
		expect(tasks.storage.shape.workspace).toBe(shared.workspace)
		expect(tasks.storage.safeParse({ ...task, workspace: 'blocked' }).success).toBe(false)
		expect(Object.keys(tasks.storage.shape).slice(0, 5)).toEqual([
			'owner',
			'workspace',
			'note',
			'secret',
			'title',
		])
	})

	it('uses combined fields in allowlists, write masks, DTO extensions and tools', () => {
		const tasks = createTable(shared)(
			'tasks',
			{ title: k.string(), parent: k.id('tasks').optional() },
			{
				serverFields: ['secret'],
				commandFields: ['workspace', 'note', 'title'],
				publicFields: ['workspace', 'owner', 'title', 'createdAt'],
			},
		)
		const task = {
			owner: idOf('users', 'users:1'),
			workspace: 'work',
			secret: 'hidden',
			title: 't',
			createdAt: 1,
			_id: idOf('tasks', 'tasks:1'),
		}
		expect(tasks.insert('owner').parse({ workspace: 'work', title: 't' })).toEqual({
			workspace: 'work',
			title: 't',
		})
		expect(tasks.update('workspace').safeParse({ workspace: 'work' }).success).toBe(false)
		expect(tasks.insertSchema.safeParse(task).success).toBe(false)
		expect(tasks.tools.insert.parse({ workspace: 'work', title: 't' })).toEqual({
			workspace: 'work',
			title: 't',
		})
		expect(tasks.tools.insert.safeParse({ workspace: 'blocked', title: 't' }).success).toBe(false)
		expect(
			tasks.tools.insert.safeParse({ workspace: 'work', title: 't', secret: 's' }).success,
		).toBe(false)
		expect(tasks.tools.update.parse({ id: task._id, data: { note: 'n' } })).toEqual({
			id: task._id,
			data: { note: 'n' },
		})
		expect(
			tasks.tools.update.safeParse({ id: task._id, data: { workspace: 'blocked' } }).success,
		).toBe(false)
		const extend = { label: k.string().min(1) }
		const dto = tasks.toPublicDto(task, { _id: true, extend, values: { label: 'visible' } })
		expect(dto).toEqual({
			owner: task.owner,
			workspace: 'work',
			title: 't',
			createdAt: 1,
			_id: task._id,
			label: 'visible',
		})
		expect(tasks.dto({ _id: true, extend }).parse(dto)).toEqual(dto)
		expect(
			tasks
				.paginationOpts({ workspace: true, owner: true })
				.parse({ numItems: 1, cursor: null, filters: { workspace: 'work', owner: task.owner } })
				.filters,
		).toEqual({ workspace: 'work', owner: task.owner })
	})

	it('persists two independent schemas with shared indexes and native id validation', async () => {
		const customTable = createTable(shared)
		const tasks = customTable(
			'tasks',
			{ title: k.string(), parent: k.id('tasks').optional() },
			{
				serverFields: ['secret'],
				commandFields: ['workspace', 'owner', 'title'],
				publicFields: ['workspace', 'title'],
			},
		)
		const issues = customTable('issues', { severity: k.number() })
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
					args: tasks.commandInput.validator,
					returns: tasks.dto(true).outputValidator,
					handler: async (ctx, args) => {
						const command = tasks.commandInput.parse(args)
						const id = await ctx.db.insert('tasks', { ...command, secret: 'server' })
						const stored = await ctx.db.get('tasks', id)
						if (!stored) throw new Error('Missing inserted task')
						return tasks.toPublicDto(stored, true)
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
			const stored = await ctx.db
				.query('tasks')
				.withIndex('by_owner', (q) => q.eq('owner', owner))
				.unique()
			expect(stored).toMatchObject({ owner, secret: 'server', title: 'task', _id: dto._id })
			expect(tasks.schema.parse(stored)).toEqual(stored)
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
			// @ts-expect-error foreign native ids must also fail Convex validation
			t.mutation(app.api.functions.create, { owner: foreign, workspace: 'work', title: 'bad' }),
		).rejects.toThrow()
		expect(tasks.storage.validator.fields.owner).toMatchObject({ kind: 'id', tableName: 'users' })
		expect(tasks.schema.validator.fields._id).toMatchObject({ kind: 'id', tableName: 'tasks' })
		expect(tasks.storage.validator.fields.parent).toMatchObject({
			kind: 'id',
			tableName: 'tasks',
			isOptional: 'optional',
		})
	})

	it('rejects duplicate names even for the same schema', () => {
		const field = k.string()
		const customTable = createTable({ name: field })
		const dynamic = Object.fromEntries([['name', field]])
		expect(() => customTable('tasks', dynamic)).toThrow(/duplicate.*name/i)
		expect(() => customTable('tasks', { ...dynamic, title: k.string() })).toThrow(
			/duplicate.*name/i,
		)
		// @ts-expect-error known duplicates are rejected as well as dynamic duplicates
		expect(() => customTable('tasks', { name: field })).toThrow(/duplicate.*name/i)
	})

	it('validates combined field lists with the ordinary table rules', () => {
		const customTable = createTable({ secret: k.string(), name: k.string() })
		expect(() =>
			// @ts-expect-error known server-owned command inputs are also rejected statically
			customTable('tasks', {}, { serverFields: ['secret'], commandFields: ['secret'] }),
		).toThrow(/server-owned field/i)
		// @ts-expect-error unknown field lists are also rejected statically
		expect(() => customTable('tasks', {}, { publicFields: ['missing'] })).toThrow(
			/unknown table field/i,
		)
	})

	it.each(['_id', '_creationTime', 'createdAt', 'updatedAt', 'archivedAt'])(
		'rejects reserved %s in both shapes',
		(key) => {
			expect(() => createTable(Object.fromEntries([[key, k.number()]]))).toThrow(
				/reserved table field/i,
			)
			expect(() =>
				createTable({ name: k.string() })('tasks', Object.fromEntries([[key, k.number()]])),
			).toThrow(/reserved table field/i)
		},
	)
})

describe('laziness (F2, R22)', () => {
	function fresh() {
		const title = k.literal('fresh-title')
		const owner = k.id('lazy_owners')
		const table = kTable(
			'lazy',
			{ title, owner },
			{ commandFields: ['title'], publicFields: ['title'] },
		)
		return { title, owner, table }
	}

	it('reading tableName builds nothing: no native validator and no defineTable', () => {
		const { title, owner, table } = fresh()
		expect(table.tableName).toBe('lazy')
		expect(title.native).toBeUndefined()
		expect(owner.native).toBeUndefined()
	})

	it('reading one boundary builds that boundary only, and no native validator', () => {
		const { title, owner, table } = fresh()
		const command = table.commandInput
		expect(command).toBe(table.commandInput)
		expect(command.native).toBeUndefined()
		expect(title.native).toBeUndefined()
		expect(owner.native).toBeUndefined()
		expect(table.insertSchema).toBe(table.insertSchema)
		expect(table.insertSchema.shape.owner).toBe(owner)
		expect(owner.native).toBeUndefined()
	})

	it('defineTable runs on the first read of .table, once', () => {
		const { title, owner, table } = fresh()
		expect(owner.native).toBeUndefined()
		const definition = table.table
		expect(definition).toBe(table.table)
		expect(owner.native).toBeDefined()
		expect(title.native).toBeDefined()
		expect(table.storage.native).toBeDefined()
	})

	it('derived boundaries are memoised per table', () => {
		const { table } = fresh()
		for (const read of [
			() => table.storage,
			() => table.schema,
			() => table.insertSchema,
			() => table.updateSchema,
			() => table.commandInput,
			() => table.publicDto,
			() => table.tools,
		])
			expect(read()).toBe(read())
	})
})

describe('namespace helpers', () => {
	it('are one implementation shared by the namespace module, the table entry and the root entry', () => {
		for (const name of [
			'createModule',
			'memberName',
			'namespace',
			'namespaceIndex',
			'namespaceName',
			'namespacePrefix',
			'tablesOf',
		] as const) {
			expect(v2[name], name).toBe(namespaces[name])
			expect(root[name], name).toBe(namespaces[name])
		}
	})

	it('accept v2 table boundaries as namespace members', () => {
		const items = kTable('Inventory_Items', { name: k.string() })
		const ns = v2.namespace('Inventory', { Inventory_Items: items }, { prefixed: true })
		expect(v2.tablesOf(ns)).toEqual(['Inventory_Items'])
		expect(v2.namespaceName(ns)).toBe('Inventory')
		expect(v2.memberName('Inventory_Items', 'Inventory')).toBe('Items')
		expect(v2.createModule(ns)).toEqual({ Inventory_Items: items.table })
	})
})
