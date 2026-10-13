import { expect, test } from 'vite-plus/test'
import { z } from 'zod'
import {
	defineRelations,
	getRelationMetadata,
	type RelationBuilder,
	type RelationTables,
	type RelationDeclarations,
	type FieldReference,
} from '../src/relations'
import { zodTable, zodToConvex } from '../src/zod-table'
import { defineTestApp } from 'convex-test'
import { defineSchema, defineTable } from 'convex/server'
import {
	idUnionTables,
	idUnionSchema,
	idUnionRelations,
	members,
} from './fixture-querying/id-unions'

// SAFETY: declaration negatives deliberately exercise untyped JavaScript callers.
const unchecked = defineRelations as (
	tables: RelationTables,
	declare: (
		r: RelationBuilder<RelationTables>,
		branch: (
			table: string,
			tag: string,
		) => Record<string, FieldReference<string, string, any, any>>,
	) => RelationDeclarations,
) => { identity: string }

test('eight native members narrow in both directions and preserve original validator', () => {
	const tables = idUnionTables(),
		registry = idUnionRelations(tables)
	const data = getRelationMetadata(registry)
	expect(data.tables.tasks.fields.rel.idTables).toEqual([...members].sort())
	expect(data.tables.tasks.fields.rel.optional).toBe(true)
	expect(data.tables.tasks.fields.rel.nullable).toBe(true)
	expect(zodToConvex(tables.tasks.schema).kind).toBe('object')
	expect(registry.identity).toBe(idUnionRelations(idUnionTables()).identity)
	expect(registry.identity).not.toBe(idUnionRelations(tables, 'clients').identity)
})

test('singleton, duplicates, nullish and repeated selection are owned frozen references', () => {
	const tasks = zodTable('tasks', (id) => ({
		single: id('tasks').optional(),
		duplicate: z.union([id('tasks'), id('tasks'), z.null()]).optional(),
	}))
	defineRelations({ tasks }, (r) => {
		for (const original of [r.tasks.single, r.tasks.duplicate]) {
			const selected = original.forTable('tasks')
			expect(selected).not.toBe(original)
			expect(Object.isFrozen(selected)).toBe(true)
			expect(() => Object.assign(selected, { table: 'foreign' })).toThrow()
			const again = selected.forTable('tasks')
			expect(Object.isFrozen(again)).toBe(true)
		}
		return {
			tasks: {
				singleLink: r.one.tasks({ from: r.tasks.single.forTable('tasks'), to: r.tasks._id }),
				duplicateLink: r.one.tasks({ from: r.tasks.duplicate.forTable('tasks'), to: r.tasks._id }),
			},
		}
	})
})

test('invalid/native-mixed/null-only/unregistered/repeated selectors reject without weakening exact scalar compatibility', () => {
	const tasks = zodTable('tasks', (id) => ({
		rel: z
			.union([id('tasks'), id('missing')])
			.nullable()
			.optional(),
		mixed: z.union([id('tasks'), z.string()]),
		nil: z.null(),
		scalar: z.union([z.string(), z.number()]),
		text: z.string(),
	}))
	for (const [field, member] of [
		['rel', 'unknown'],
		['rel', 'missing'],
		['mixed', 'tasks'],
		['nil', 'tasks'],
		['scalar', 'tasks'],
	] as const)
		expect(() =>
			unchecked({ tasks }, (r) => {
				r.tasks[field].forTable(member)
				return {}
			}),
		).toThrow(/native ID|member|registered/)
	expect(() =>
		unchecked({ tasks }, (r) => {
			r.tasks.rel.forTable('tasks').forTable('missing')
			return {}
		}),
	).toThrow(/member/)
	expect(() =>
		unchecked({ tasks }, (r) => ({
			tasks: { wrong: r.one.tasks({ from: r.tasks.scalar, to: r.tasks.text }) },
		})),
	).toThrow(/Incompatible/)
	defineRelations({ tasks }, (r) => ({
		tasks: { valid: r.one.tasks({ from: r.tasks.rel.forTable('tasks'), to: r.tasks._id }) },
	}))
})

test('foreign/forged selections and wrong ID targets reject', () => {
	const tables = idUnionTables()
	expect(() =>
		unchecked(tables, (r) => {
			r.tasks.rel.forTable('tasks').forTable('clients')
			return {}
		}),
	).toThrow(/member/)
	for (const inverse of [false, true])
		expect(() =>
			unchecked(tables, (r) => ({
				tasks: {
					bad: inverse
						? r.many.tasks({ from: r.tasks._id, to: r.tasks.rel })
						: r.one.tasks({ from: r.tasks.rel, to: r.tasks._id }),
				},
			})),
		).toThrow(/Incompatible/)
	let foreign: FieldReference<string, string, any, any>
	unchecked(tables, (r) => {
		foreign = r.tasks.rel.forTable('tasks')
		return {}
	})
	expect(() =>
		unchecked(tables, (r) => ({
			tasks: { bad: r.one.tasks({ from: foreign!, to: r.tasks._id }) },
		})),
	).toThrow(/Foreign/)
	expect(() =>
		unchecked(tables, (r) => ({
			tasks: { bad: r.one.tasks({ from: { ...r.tasks.rel.forTable('tasks') }, to: r.tasks._id }) },
		})),
	).toThrow(/Foreign/)
	expect(() =>
		unchecked(tables, (r) => ({
			tasks: { bad: r.one.clients({ from: r.tasks.rel.forTable('tasks'), to: r.clients._id }) },
		})),
	).toThrow(/Incompatible/)
})

test('branch-scoped selections and every narrowed through placement fail explicitly', () => {
	const tables = idUnionTables()
	expect(() =>
		unchecked(tables, (_, branch) => {
			// @ts-expect-error deliberate JS runtime probe of deferred scoped narrowing
			branch('payments', 'posted').clientId.forTable('clients')
			return {}
		}),
	).toThrow(/branch-scoped/)
	for (const narrowBase of [true, false])
		expect(() =>
			unchecked(tables, (r) => {
				if (narrowBase) {
					// @ts-expect-error deliberate JS runtime probe of narrowed base
					r.tasks.rel.forTable('tasks').through(r.tasks._id)
				} else {
					// @ts-expect-error deliberate JS runtime probe of narrowed junction
					r.tasks._id.through(r.tasks.rel.forTable('tasks'))
				}
				return {}
			}),
		).toThrow(/through/)
})

test('member metadata is immutable, separate from discriminator scope, and deterministic', () => {
	const registry = idUnionRelations(idUnionTables()),
		metadata = getRelationMetadata(registry)
	const source = metadata.declarations.tasks.postedPayment.sourceMember!
	const target = metadata.declarations.clients.tasks.targetMember!
	expect(source).toEqual({ table: 'payments' })
	expect(target).toEqual({ table: 'clients' })
	expect(metadata.declarations.tasks.postedPayment.targetGuard).toEqual({
		discriminator: 'type',
		tag: 'posted',
	})
	for (const value of [source, target]) {
		expect(Object.isFrozen(value)).toBe(true)
		expect(() => Object.assign(value, { table: 'tasks' })).toThrow()
	}
	expect(registry.identity).toBe(idUnionRelations(idUnionTables()).identity)
})

test('generated optional native union input and DTO validators reject arbitrary/unlisted/incorrect relation ID brands', async () => {
	const tables = idUnionTables(),
		relations = idUnionRelations(tables)
	const base = defineTestApp({
		schema: defineSchema({ ...idUnionSchema(tables).tables, outsiders: defineTable({}) }),
	})
	const insert = tables.tasks.insert(),
		update = tables.tasks.update()
	const app = base.defineModules({
		functions: {
			input: base.query({
				args: { value: zodToConvex(tables.tasks.schema.shape.rel) },
				handler: (_, args) => args.value ?? null,
			}),
			insert: base.query({
				args: { input: zodToConvex(insert) },
				handler: (_, args) => args.input.rel ?? null,
			}),
			update: base.query({
				args: { input: zodToConvex(update) },
				handler: (_, args) => args.input.rel ?? null,
			}),
			filter: base.query({
				args: {
					input: zodToConvex(relations.tables.tasks.paginationOpts({ client: { _id: true } })),
				},
				handler: () => true,
			}),
		},
	})
	const t = app.createTest()
	const ids = await t.run(async (ctx) => ({
		tasks: await ctx.db.insert('tasks', {
			ordinal: 0,
			status: 'open',
			allowed: true,
			department: 'a',
			secret: 'secret',
		}),
		clients: await ctx.db.insert('clients', {
			name: 'C',
			allowed: true,
			department: 'a',
			secret: 'secret',
		}),
		outside: await ctx.db.insert('outsiders', {}),
	}))
	const remaining = await t.run(async (ctx) => {
		const fields = { name: 'Public', allowed: true, department: 'a', secret: 'secret' }
		return [
			await ctx.db.insert('leads', fields),
			await ctx.db.insert('contacts', fields),
			await ctx.db.insert('creditors', fields),
			await ctx.db.insert('deals', { ...fields, clientId: ids.clients }),
			await ctx.db.insert('payments', {
				...fields,
				type: 'posted',
				amount: 1,
				clientId: ids.clients,
			}),
			await ctx.db.insert('ledger', { ...fields, type: 'debit', amount: 1, clientId: ids.clients }),
		]
	})
	for (const value of [ids.tasks, ids.clients, ...remaining, null, undefined])
		await expect(t.query(app.api.functions.input, { value })).resolves.toBe(value ?? null)
	for (const value of ['arbitrary', ids.outside]) {
		// @ts-expect-error deliberate wrong native ID input at the public validator
		await expect(t.query(app.api.functions.input, { value })).rejects.toThrow()
	}
	const input = {
		ordinal: 0,
		status: 'open',
		allowed: true,
		department: 'a',
		secret: 'secret',
		rel: ids.clients,
	}
	await expect(t.query(app.api.functions.insert, { input })).resolves.toBe(ids.clients)
	await expect(t.query(app.api.functions.update, { input: { rel: null } })).resolves.toBeNull()
	await expect(t.query(app.api.functions.update, { input: {} })).resolves.toBeNull()
	await expect(
		t.query(app.api.functions.filter, {
			input: { numItems: 1, cursor: null, filters: { client: { _id: ids.clients } } },
		}),
	).resolves.toBe(true)
	await expect(
		t.query(app.api.functions.filter, {
			// @ts-expect-error target DTO/filter ID brands remain table-specific
			input: { numItems: 1, cursor: null, filters: { client: { _id: ids.tasks } } },
		}),
	).rejects.toThrow()
})

test('caller dictionary mutation cannot register a previously unregistered selector', () => {
	const tasks = zodTable('tasks', (id) => ({ rel: z.union([id('tasks'), id('missing')]) }))
	const tables = { tasks }
	expect(() =>
		unchecked(tables, (r) => {
			Object.assign(tables, { missing: zodTable('missing', () => ({ name: z.string() })) })
			r.tasks.rel.forTable('missing')
			return {}
		}),
	).toThrow(/not registered/)
})
