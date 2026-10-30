import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { defineTestApp } from 'convex-test'
import {
	defineRelations,
	verifyRelations,
	getRelationExecutor,
	getRelationMetadata,
	type RelationTables,
	type RelationBuilder,
	type RelationDeclarations,
	type RelationRegistry,
} from '../src/relations'
import { compileFilters } from '../src/querying/filters'
import { zodTable, zodToConvex } from '../src/zod-table'

function fixture() {
	const tasks = zodTable(
		'tasks',
		(id) => ({
			title: z.string(),
			reference: id('tasks').nullable(),
			active: z.boolean(),
			count: z.number(),
			code: z.string(),
			status: z.enum(['open', 'done']).nullable(),
		}),
		{ publicFields: ['title'] },
	)
	const labels = zodTable('labels', () => ({ name: z.string(), code: z.string() }), {
		publicFields: ['name'],
	})
	const links = zodTable('links', (id) => ({ taskId: id('tasks'), labelId: id('labels') }))
	tasks.table.index('by_active', ['active']).index('by_count', ['count']).index('by_code', ['code'])
	labels.table.index('by_code', ['code'])
	links.table.index('by_task', ['taskId'])
	const tables = { tasks, labels, links }
	const relations = defineRelations(tables, (r) => ({
		tasks: {
			referencedTask: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }),
			second: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }),
			labels: r.many.labels({
				from: r.tasks._id.through(r.links.taskId),
				to: r.labels._id.through(r.links.labelId),
			}),
		},
	}))
	return { tables, relations }
}

describe('relation registry', () => {
	test('explicit self, two named edges, and junction metadata', () => {
		const { relations } = fixture()
		expect(relations.identity).toBe(fixture().relations.identity)
		expect(
			relations.tables.tasks.pageDto({ referencedTask: true, labels: true }).safeParse({
				page: [
					{
						_id: 'tasks:1',
						title: 't',
						referencedTask: null,
						labels: { page: [{ _id: 'labels:1', name: 'l' }], isDone: true, continueCursor: '' },
					},
				],
				isDone: true,
				continueCursor: '',
			}).success,
		).toBe(true)
	})
	test('relation filters share strict native scalar grammar', () => {
		const { relations } = fixture()
		const schema = relations.tables.tasks.paginationOpts({
			title: true,
			referencedTask: { title: true },
			labels: { name: true },
		})
		expect(
			schema.safeParse({
				numItems: 1,
				cursor: null,
				filters: { title: 't', referencedTask: null, labels: { some: { name: 'l' } } },
			}).success,
		).toBe(true)
		expect(
			schema.safeParse({ numItems: 1, cursor: null, filters: { labels: { all: {} } } }).success,
		).toBe(false)
		expect(
			schema.safeParse({ numItems: 1, cursor: null, filters: { referencedTask: { active: true } } })
				.success,
		).toBe(false)
		expect(zodToConvex(schema).kind).toBe('object')
	})
})

describe('guaranteed equality compiler', () => {
	test('unsafe OR, common OR, conflicts, NOT and in', () => {
		const { tables } = fixture()
		const schema = tables.tasks.paginationOpts({ active: true, count: true, code: true })
		const indexes = [
			{ name: 'by_active', fields: ['active', '_creationTime'] },
			{ name: 'by_count', fields: ['count', '_creationTime'] },
		]
		const compile = (filters: z.input<typeof schema>['filters']) =>
			compileFilters(schema, { numItems: 1, cursor: null, filters }, indexes)
		expect(compile({ or: [{ active: false }, { count: 0 }] }).index).toBeNull()
		expect(
			compile({
				or: [
					{ active: false, count: 1 },
					{ active: false, count: 2 },
				],
			}).index?.name,
		).toBe('by_active')
		expect(compile({ and: [{ count: 1 }, { count: 2 }] }).unsatisfiable).toBe(true)
		expect(compile({ not: { count: 1 } }).index).toBeNull()
		expect(compile({ count: { in: [1, 1] } }).index?.name).toBe('by_count')
		const multi = compile({ count: { in: [1, 2] } })
		expect(multi.index?.name).toBe('by_count')
		expect(multi.expansion).toEqual({ field: 'count', values: [1, 2], comparator: 'tail' })
	})
	test('present gates do not bind fields', () => {
		const { tables } = fixture()
		const schema = tables.tasks.paginationOpts({ active: true, count: true, code: true })
		const indexes = [
			{ name: 'by_code', fields: ['code'] },
			{ name: 'by_count', fields: ['count'] },
			{ name: 'by_active', fields: ['active'] },
		]
		for (const [gate, name, filters] of [
			[false, 'by_active', { active: false }],
			[0, 'by_count', { count: 0 }],
			['', 'by_code', { code: '' }],
		] as const) {
			expect(
				compileFilters(schema, { numItems: 1, cursor: null, filters }, indexes, [
					{ value: gate, index: name },
				]).index?.name,
			).toBe(name)
		}
		expect(() =>
			compileFilters(schema, { numItems: 1, cursor: null }, indexes, [
				{ value: false, index: 'by_active' },
			]),
		).toThrow(/incompatible/)
	})
})

// SAFETY: this adapter deliberately models JS callers bypassing the compile-time guards.
// Per-table and edge checks run on first use; verification runs all of them now.
const verified: typeof defineRelations = (tables, declare) => {
	const registry = defineRelations(tables, declare)
	verifyRelations(registry)
	return registry
}
const unchecked = verified as (
	tables: RelationTables,
	declare: (r: RelationBuilder<RelationTables>) => RelationDeclarations,
) => RelationRegistry<RelationTables, RelationDeclarations>

describe('invalid native relation paths', () => {
	test('wrong brands, wrong source, field/name collisions and foreign registry references', () => {
		const { tables } = fixture()
		expect(() =>
			unchecked(tables, (r) => ({
				tasks: { bad: r.one.labels({ from: r.tasks._id, to: r.labels._id }) },
			})),
		).toThrow(/Incompatible/)
		expect(() =>
			unchecked(tables, (r) => ({
				labels: { bad: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }) },
			})),
		).toThrow(/source bucket/)
		expect(() =>
			unchecked(tables, (r) => ({
				tasks: { title: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }) },
			})),
		).toThrow(/collision/)
		for (const name of [
			'and',
			'or',
			'not',
			'fields',
			'then',
			'constructor',
			'prototype',
			'__proto__',
		])
			expect(() =>
				unchecked(tables, (r) => ({
					tasks: { [name]: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }) },
				})),
			).toThrow(/collision/)
		let foreign: RelationBuilder<RelationTables> | undefined
		unchecked(tables, (r) => {
			foreign = r
			return {}
		})
		expect(() =>
			unchecked(tables, (r) => ({
				tasks: { bad: r.one.tasks({ from: foreign!.tasks.reference, to: r.tasks._id }) },
			})),
		).toThrow(/Foreign registry/)
		expect(() =>
			unchecked(tables, (r) => ({
				tasks: { bad: r.one.labels({ from: r.tasks.reference, to: r.tasks._id }) },
			})),
		).toThrow(/target table/)
		expect(() =>
			unchecked(tables, (r) => ({
				missing: { bad: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }) },
			})),
		).toThrow(/Unknown source/)
		expect(() =>
			unchecked(tables, (r) => ({
				tasks: { bad: r.one.tasks({ from: r.tasks.missing, to: r.tasks._id }) },
			})),
		).toThrow()
	})
	test('ordinary target lookup needs leading active index, direct many is accepted', () => {
		for (const mode of ['missing', 'nonprefix', 'staged', 'active'] as const) {
			const owners = zodTable('owners', () => ({ code: z.string() }))
			const children = zodTable('children', () => ({ owner: z.string(), extra: z.string() }))
			if (mode === 'nonprefix') children.table.index('by_extra_owner', ['extra', 'owner'])
			if (mode === 'staged') children.table.index('by_owner', { fields: ['owner'], staged: true })
			if (mode === 'active') children.table.index('by_owner', ['owner'])
			const construct = () =>
				verified({ owners, children }, (r) => ({
					owners: { children: r.many.children({ from: r.owners.code, to: r.children.owner }) },
				}))
			if (mode === 'active')
				expect(construct().tables.owners.pageDto({ children: true })).toBeDefined()
			else expect(construct).toThrow(/active index begins/)
		}
	})
	test('nullable enum domain compatibility uses native types, not null union ordering', () => {
		const parents = zodTable('parents', () => ({ status: z.enum(['open', 'done']).nullable() }))
		const targets = zodTable('targets', () => ({
			status: z.enum(['done', 'open']),
			bad: z.enum(['open', 'other']).nullable(),
		}))
		targets.table.index('by_status', ['status']).index('by_bad', ['bad'])
		expect(
			defineRelations({ parents, targets }, (r) => ({
				parents: { target: r.one.targets({ from: r.parents.status, to: r.targets.status }) },
			})),
		).toBeDefined()
		expect(() =>
			unchecked({ parents, targets }, (r) => ({
				parents: { bad: r.one.targets({ from: r.parents.status, to: r.targets.bad }) },
			})),
		).toThrow(/Incompatible/)
	})
	test('junction source prefix, both legs, same junction and non-ID target index', () => {
		const { tables } = fixture()
		const links2 = zodTable('links2', (id) => ({ taskId: id('tasks'), labelId: id('labels') }))
		links2.table.index('by_task', ['taskId'])
		expect(() =>
			unchecked({ ...tables, links2 }, (r) => ({
				tasks: {
					bad: r.many.labels({
						from: r.tasks._id.through(r.links.taskId),
						to: r.labels._id.through(r.links2.labelId),
					}),
				},
			})),
		).toThrow(/Different junction/)
		expect(() =>
			unchecked(tables, (r) => ({
				tasks: {
					// @ts-expect-error deliberate JS bypass of one-sided through rejection
					bad: r.many.labels({ from: r.tasks._id.through(r.links.taskId), to: r.labels._id }),
				},
			})),
		).toThrow(/Both relation legs/)
		expect(() =>
			unchecked(tables, (r) => ({
				tasks: {
					bad: r.many.labels({
						from: r.tasks._id.through(r.links.labelId),
						to: r.labels._id.through(r.links.labelId),
					}),
				},
			})),
		).toThrow(/junction field/)
		const junction = zodTable('junction', (id) => ({ taskId: id('tasks'), labelCode: z.string() }))
		expect(() =>
			verified({ ...tables, junction }, (r) => ({
				tasks: {
					bad: r.many.labels({
						from: r.tasks._id.through(r.junction.taskId),
						to: r.labels.code.through(r.junction.labelCode),
					}),
				},
			})),
		).toThrow(/junction.taskId/)
		junction.table.index('by_task', ['taskId'])
		const labels = zodTable('labels', () => ({ name: z.string(), code: z.string() }))
		expect(() =>
			verified({ ...tables, labels, junction }, (r) => ({
				tasks: {
					bad: r.many.labels({
						from: r.tasks._id.through(r.junction.taskId),
						to: r.labels.code.through(r.junction.labelCode),
					}),
				},
			})),
		).toThrow(/labels.code/)
	})
})

interface TestSelection {
	[key: string]: true | TestSelection
}
interface TestFilter {
	[key: string]: string | TestFilter | TestFilter[]
}

describe('finite shared grammar and selections', () => {
	test('mixed boolean, many/one target depth four and one beyond, including clones', () => {
		const { relations } = fixture()
		const opts = relations.tables.tasks.paginationOpts({
			title: true,
			referencedTask: { title: true, referencedTask: { title: true } },
			labels: { name: true },
		})
		const boundary = [
			{ and: [{ not: { or: [{ referencedTask: { title: 't' } }] } }] },
			{ not: { and: [{ or: [{ labels: { some: { name: 'l' } } }] }] } },
			{ referencedTask: { not: { referencedTask: { not: { title: 't' } } } } },
		]
		const beyond = [
			{ and: [{ not: { or: [{ referencedTask: { not: { title: 't' } } }] } }] },
			{ not: { and: [{ or: [{ labels: { none: { not: { name: 'l' } } } }] }] } },
			{ referencedTask: { not: { referencedTask: { not: { not: { title: 't' } } } } } },
		]
		for (const schema of [opts, opts.clone()]) {
			for (const filters of boundary)
				expect(schema.safeParse({ numItems: 1, cursor: null, filters }).success).toBe(true)
			for (const filters of beyond)
				expect(schema.safeParse({ numItems: 1, cursor: null, filters }).success).toBe(false)
		}
		const manyWide = {
			and: Array.from({ length: 63 }, () => ({ labels: { some: { name: 'l' } } })),
			title: 't',
			count: 0,
		}
		const wideOpts = relations.tables.tasks.paginationOpts({
			title: true,
			count: true,
			labels: { name: true },
		})
		expect(wideOpts.safeParse({ numItems: 1, cursor: null, filters: manyWide }).success).toBe(true)
		expect(
			wideOpts.safeParse({ numItems: 1, cursor: null, filters: { ...manyWide, fields: {} } })
				.success,
		).toBe(false)
	})
	test('cyclic/getter/wide selections reject before building grammar, depth matches types', () => {
		const { relations } = fixture()
		const valid: TestSelection = {
			referencedTask: { referencedTask: { referencedTask: { referencedTask: true } } },
		}
		const invalid = { referencedTask: valid }
		// SAFETY: intentional widened masks exercise construction guards for JS callers.
		const output = relations.tables.tasks.pageDto as (selection: TestSelection) => z.ZodType
		expect(output(valid)).toBeDefined()
		expect(() => output(invalid)).toThrow(/deep/)
		const cycle: TestSelection = {}
		cycle.referencedTask = cycle
		expect(() => output(cycle)).toThrow(/cycle/)
		let getters = 0
		expect(() =>
			output({
				get referencedTask() {
					getters++
					return true as const
				},
			}),
		).toThrow(/property/)
		expect(getters).toBe(0)
		expect(() =>
			output(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`edge${i}`, true]))),
		).toThrow(/budget/)
		const opts = relations.tables.tasks.paginationOpts({
			referencedTask: { title: true },
			labels: { name: true },
		})
		const filterCycle: TestFilter = {}
		filterCycle.and = [filterCycle]
		expect(opts.safeParse({ numItems: 1, cursor: null, filters: filterCycle }).success).toBe(false)
		const getterFilters = {
			referencedTask: {
				get title() {
					getters++
					return 't'
				},
			},
		}
		expect(opts.safeParse({ numItems: 1, cursor: null, filters: getterFilters }).success).toBe(
			false,
		)
		expect(getters).toBe(0)
	})
	test('nested DTOs remain strict, include IDs and preserve native page metadata', () => {
		const { relations } = fixture()
		const schema = relations.tables.tasks.pageDto({
			referencedTask: { labels: true },
			labels: true,
		})
		const terminal = {
			page: [],
			isDone: false,
			continueCursor: 'sealed',
			splitCursor: 'split',
			pageStatus: 'SplitRequired',
		}
		const good = {
			page: [
				{
					_id: 'tasks:1',
					title: 't',
					referencedTask: { _id: 'tasks:2', title: 'u', labels: terminal },
					labels: terminal,
				},
			],
			isDone: false,
			continueCursor: 'sealed',
		}
		expect(schema.safeParse(good).success).toBe(true)
		expect(
			schema.safeParse({ ...good, page: [{ ...good.page[0], reference: 'tasks:3' }] }).success,
		).toBe(false)
		expect(() =>
			relations.tables.tasks
				.paginationOpts({ title: true, referencedTask: { title: true } })
				.parse({ numItems: 1, cursor: null, order: 'sideways' }),
		).toThrow()
	})
})

describe('immutable registry identity', () => {
	test('mutating a helper output graph changes only that result, preserving private projection', () => {
		const items = zodTable('items', () => ({ profile: z.object({ text: z.string() }) }), {
			publicFields: ['profile'],
		})
		const registry = defineRelations({ items }, () => ({}))
		const first = registry.tables.items.pageDto({})
		const second = registry.tables.items.pageDto({})
		if (!(first instanceof z.ZodObject) || !(second instanceof z.ZodObject))
			throw new Error('Expected object helper')
		const identity = registry.identity
		Reflect.set(first.shape.page.element.shape.profile.shape, 'text', z.number())
		const row = { _id: 'items:1', profile: { text: 'ok' }, private: 'secret' }
		const page = {
			page: [{ _id: row._id, profile: row.profile }],
			isDone: true,
			continueCursor: '',
		}
		expect(first.safeParse(page).success).toBe(false)
		expect(second.parse(page)).toEqual(page)
		expect(registry.tables.items.pageDto({}).parse(page)).toEqual(page)
		expect(getRelationExecutor(registry).project('items', row, () => true)).toEqual(page.page[0])
		expect(registry.identity).toBe(identity)
		expect(() => second.clone().extend({ extra: z.string().optional() }).partial()).not.toThrow()
	})
	test('each pagination helper owns its scalar checks independently of private parsing', () => {
		const { relations } = fixture()
		const first = relations.tables.tasks.paginationOpts({ title: true })
		const second = relations.tables.tasks.paginationOpts({ title: true })
		const executor = getRelationExecutor(relations)
		const privateInput = executor.pagination('tasks')
		Reflect.set(first.shape.numItems._zod.def.checks![1]._zod.def, 'value', 99)
		const args = { numItems: 1, cursor: null }
		expect(first.safeParse(args).success).toBe(false)
		expect(second.safeParse(args).success).toBe(true)
		expect(privateInput.safeParse(args).success).toBe(true)
		const filters = first.shape.filters.unwrap()
		if (!(filters instanceof z.ZodObject)) throw new Error('Expected filter object')
		Reflect.set(filters.shape.fields.unwrap().shape, 'title', z.number().optional())
		const filtered = { ...args, filters: { fields: { title: 'valid' } } }
		expect(first.safeParse(filtered).success).toBe(false)
		expect(second.safeParse(filtered).success).toBe(true)
		expect(privateInput.safeParse(filtered).success).toBe(true)
	})
	test('new registries adopt valid source refinement and index changes', () => {
		const text = z.string().refine((value) => value === 'valid')
		const items = zodTable('items', () => ({ text }), { publicFields: ['text'] })
		// Each table is captured on first use; verification uses every table now.
		const first = verified({ items }, () => ({}))
		Reflect.set(text._zod.def.checks![0]._zod.def, 'fn', () => false)
		items.table.index('late', ['text'])
		const second = defineRelations({ items }, () => ({}))
		const page = { page: [{ _id: 'items:1', text: 'valid' }], isDone: true, continueCursor: '' }
		expect(first.tables.items.pageDto({}).safeParse(page).success).toBe(true)
		expect(second.tables.items.pageDto({}).safeParse(page).success).toBe(false)
		expect(getRelationMetadata(first).tables.items.indexes).toEqual([])
		expect(getRelationMetadata(second).tables.items.indexes).toEqual([
			{ name: 'late', fields: ['text'] },
		])
	})
	test('first use captures validation before later source mutation', () => {
		const expression = /^valid$/
		const text = z
			.string()
			.regex(expression)
			.refine((value) => value === 'valid')
		const profile = z.object({ text })
		const items = zodTable('items', () => ({ profile }), { publicFields: ['profile'] })
		const registry = defineRelations({ items }, () => ({}))
		registry.tables.items.paginationOpts({})
		Reflect.set(profile.shape, 'text', z.number())
		Reflect.set(text._zod.def.checks![1]._zod.def, 'fn', () => false)
		expression.compile('changed')
		const output = registry.tables.items.pageDto({})
		const page = (text: string) => ({
			page: [{ _id: 'items:1', profile: { text } }],
			isDone: true,
			continueCursor: '',
		})
		expect(output.safeParse(page('valid')).success).toBe(true)
		expect(output.safeParse(page('changed')).success).toBe(false)
		expect(Object.isFrozen(profile.shape)).toBe(false)
	})
	test('relation DTO registration rejects opaque superRefine and check validators', () => {
		for (const text of [z.string().superRefine(() => {}), z.string().check(() => {})]) {
			const items = zodTable('items', () => ({ text }), { publicFields: ['text'] })
			expect(() => verified({ items }, () => ({}))).toThrow(/opaque.*refine/i)
		}
	})
	test('registration owns array, union, record and specialized scalar definitions', () => {
		const text = z.string().min(2)
		const list = z.array(text)
		const choice = z.union([text, z.number().int().min(3)])
		const record = z.record(z.string(), text)
		const email = z.email()
		const formatted = z.stringFormat('owned', (value) => value === 'valid')
		const tuple = z.tuple([z.int32(), z.uint64(), z.string().nullable()])
		const optional = z.string().optional().nonoptional().optional()
		const items = zodTable(
			'items',
			() => ({ list, choice, record, email, formatted, tuple, optional }),
			{
				publicFields: ['list', 'choice', 'record', 'email', 'formatted', 'tuple', 'optional'],
			},
		)
		const registry = verified({ items }, () => ({}))
		Reflect.set(list._zod.def, 'element', z.number())
		Reflect.set(choice._zod.def.options, '0', z.number())
		Reflect.set(record._zod.def, 'valueType', z.number())
		Reflect.set(text._zod.def.checks![0]._zod.def, 'minimum', 20)
		const schema = registry.tables.items.pageDto({})
		const row = {
			_id: 'items:1',
			list: ['ok'],
			choice: 'ok',
			record: { key: 'ok' },
			email: 'a@example.com',
			formatted: 'valid',
			tuple: [1, 1n, null],
		}
		const page = (value: typeof row) => ({ page: [value], isDone: true, continueCursor: '' })
		expect(schema.safeParse(page(row)).success).toBe(true)
		expect(schema.safeParse(page({ ...row, email: 'invalid' })).success).toBe(false)
		expect(schema.safeParse(page({ ...row, record: { key: '' } })).success).toBe(false)
		expect(schema.safeParse(page({ ...row, formatted: 'invalid' })).success).toBe(false)
		expect(schema.safeParse(page({ ...row, tuple: [1.5, -1n, null] })).success).toBe(false)
	})
	test('capture preserves caller object definition and parsing semantics', () => {
		const fields = { code: z.string() }
		const controlFields = { code: z.string() }
		const profile = z.object(fields).refine((value) => value.code === 'valid')
		const control = z.object(controlFields).refine((value) => value.code === 'valid')
		const boundary = zodTable('items', () => ({ profile }), { publicFields: ['profile'] })
		zodTable('control', () => ({ control }), { publicFields: ['control'] })
		const getter = Object.getOwnPropertyDescriptor(profile._zod.def, 'shape')?.get
		defineRelations({ items: boundary }, () => ({}))
		expect(Object.getOwnPropertyDescriptor(profile._zod.def, 'shape')?.get).toBe(getter)
		Reflect.set(fields, 'secret', z.string())
		Reflect.set(controlFields, 'secret', z.string())
		const input = { code: 'valid', secret: 'caller' }
		expect(profile.safeParse(input)).toEqual(control.safeParse(input))
	})
	test('unknown definition accessors are rejected without evaluation', () => {
		for (const key of ['shape', 'unexpected']) {
			const profile = z.object({ code: z.string() }).refine((value) => value.code === 'valid')
			const boundary = zodTable('items', () => ({ profile }), { publicFields: ['profile'] })
			let reads = 0
			const getter = () => {
				reads++
				return { code: z.string() }
			}
			// A caller-supplied toString must not impersonate a built-in accessor.
			getter.toString = () => 'built-in'
			Object.defineProperty(profile._zod.def, key, {
				configurable: true,
				enumerable: true,
				get: getter,
			})
			expect(() => verified({ items: boundary }, () => ({}))).toThrow(/accessor/)
			expect(reads).toBe(0)
		}
	})
	test('definition replacement getters fail before invocation and specialized coercion stays inadmissible', () => {
		const text = z.string()
		const items = zodTable('items', () => ({ text }), { publicFields: ['text'] })
		let calls = 0
		Object.defineProperty(text._zod, 'def', {
			get: () => {
				calls++
				return { type: 'string' }
			},
		})
		expect(() => verified({ items }, () => ({}))).toThrow(/accessor/)
		expect(calls).toBe(0)
		const numeric = z.coerce.number().int()
		const coerced = zodTable('coerced', () => ({ numeric }), { publicFields: ['numeric'] })
		expect(() => verified({ coerced }, () => ({}))).toThrow(/Unsupported DTO/)
	})
	test('refined object capture preserves checks and ignores drift before first cloned parse', async () => {
		const profile = z.object({ code: z.string() }).refine((value) => value.code === 'valid')
		const boundary = zodTable('items', () => ({ profile }), { publicFields: ['profile'] })
		const registry = defineRelations({ items: boundary }, () => ({}))
		const output = registry.tables.items.pageDto({})
		const clone = output.clone()
		const options = registry.tables.items.paginationOpts({}).clone()
		const empty = { page: [], isDone: true, continueCursor: '' }
		expect(Object.isFrozen(profile)).toBe(false)
		expect(Object.isFrozen(profile._zod.def)).toBe(false)
		expect(Object.isFrozen(profile.shape)).toBe(false)
		Reflect.set(profile.shape, 'secret', z.string())
		for (const schema of [output, clone]) {
			expect(schema.safeParse(empty).success).toBe(true)
			expect((await schema.safeParseAsync(empty)).success).toBe(true)
			expect(() => zodToConvex(schema)).not.toThrow()
		}
		expect(options.safeParse({ numItems: 1, cursor: null }).success).toBe(true)
		expect(() => zodToConvex(options)).not.toThrow()
		expect(() => registry.tables.items.pageDto({})).not.toThrow()
	})
	test('actual native stored document must agree with boundary kinds, optionality and ID brands', () => {
		for (const field of [v.number(), v.optional(v.string()), v.id('other')]) {
			const boundary = zodTable('items', () => ({ code: z.string() }))
			Reflect.set(boundary, 'table', defineTable({ code: field }).index('by_code', ['code']))
			expect(() => verified({ items: boundary }, () => ({}))).toThrow(/document|boundary/)
		}
		const boundary = zodTable('items', (id) => ({ owner: id('items') }))
		Reflect.set(boundary, 'table', defineTable({ owner: v.id('other') }))
		expect(() => verified({ items: boundary }, () => ({}))).toThrow(/document|boundary/)
	})
	test('nested DTO mutation leaves later helpers and already-created output schemas stable', () => {
		for (const mutate of [
			(profile: z.ZodObject) => Reflect.set(profile.shape, 'secret', z.string()),
			(profile: z.ZodObject) => Reflect.set(profile.shape, 'x', z.number()),
		]) {
			const profile = z.object({ x: z.string().min(2) })
			const boundary = zodTable('items', () => ({ profile }), { publicFields: ['profile'] })
			const registry = defineRelations({ items: boundary }, () => ({}))
			const output = registry.tables.items.pageDto({})
			const options = registry.tables.items.paginationOpts({})
			const clonedOutput = output.clone()
			const identity = registry.identity
			mutate(profile)
			expect(() => registry.tables.items.pageDto({})).not.toThrow()
			expect(() => registry.tables.items.paginationOpts({})).not.toThrow()
			expect(
				output.parse({
					page: [{ _id: 'items:1', profile: { x: 'ok', secret: 'leak' } }],
					isDone: true,
					continueCursor: '',
				}).page[0].profile,
			).toEqual({ x: 'ok' })
			expect(() => zodToConvex(output)).not.toThrow()
			for (const schema of [output, clonedOutput])
				expect(schema.safeParse({ page: [], isDone: true, continueCursor: '' }).success).toBe(true)
			expect(options.safeParse({ numItems: 1, cursor: null }).success).toBe(true)
			expect(registry.identity).toBe(identity)
		}
	})
	test('array element, union options and custom check mutations leave snapshots stable', () => {
		for (const mutate of [
			(list: z.ZodArray, _choice: z.ZodUnion, _text: z.ZodString) =>
				Reflect.set(list._zod.def, 'element', z.number()),
			(_list: z.ZodArray, choice: z.ZodUnion, _text: z.ZodString) =>
				Reflect.set(choice._zod.def.options, '0', z.number()),
			(_list: z.ZodArray, _choice: z.ZodUnion, text: z.ZodString) =>
				Reflect.set(text._zod.def.checks![0]._zod.def, 'fn', () => true),
		]) {
			const text = z.string().refine((value) => value === 'valid')
			const list = z.array(text)
			const choice = z.union([text, z.number()])
			const boundary = zodTable('items', () => ({ list, choice }), {
				publicFields: ['list', 'choice'],
			})
			const registry = defineRelations({ items: boundary }, () => ({}))
			const output = registry.tables.items.pageDto({})
			mutate(list, choice, text)
			const page = (value: string) => ({
				page: [{ _id: 'items:1', list: [value], choice: value }],
				isDone: true,
				continueCursor: '',
			})
			expect(output.safeParse(page('valid')).success).toBe(true)
			expect(output.safeParse(page('invalid')).success).toBe(false)
			expect(() => registry.tables.items.pageDto({})).not.toThrow()
			expect(output.safeParse({ page: [], isDone: true, continueCursor: '' }).success).toBe(true)
		}
	})
	test('unsupported dynamic or value-changing DTO nodes fail closed', () => {
		for (const field of [
			z.string().default('default'),
			z.string().transform((value) => value.length),
			new z.ZodPipe({ type: 'pipe', in: z.string(), out: z.string().prefault('fallback') }),
			new z.ZodPipe({
				type: 'pipe',
				in: z.object({ code: z.string() }),
				out: z.object({ code: z.string().prefault('fallback') }),
			}),
			z.coerce.number(),
			z.lazy(() => z.string()),
			z.any(),
		]) {
			const boundary = zodTable('items', () => ({ field }), { publicFields: ['field'] })
			expect(() => verified({ items: boundary }, () => ({}))).toThrow(/Unsupported/)
		}
	})
	test.each([
		['transform', z.number().transform(() => 'changed')],
		[
			'default',
			z.string().default(() => {
				throw new Error('Private default invoked')
			}),
		],
		['coercion', z.coerce.number()],
	] as const)(
		'private stored %s nodes preserve construction and strict public DTOs',
		(_name, hidden) => {
			const tasks = zodTable('tasks', () => ({ title: z.string(), hidden }), {
				publicFields: ['title'],
			})
			const relations = defineRelations({ tasks }, () => ({}))
			const output = relations.tables.tasks.pageDto({})
			const page = {
				page: [{ _id: 'tasks:1', title: 'visible' }],
				isDone: true,
				continueCursor: '',
			}
			expect(output.parse(page)).toEqual(page)
			expect(output.safeParse({ ...page, page: [{ ...page.page[0], hidden: 1 }] }).success).toBe(
				false,
			)
		},
	)
	test.each(['scalar', 'nested'] as const)(
		'private pipe %s prefault output preserves native input and strict DTOs',
		(kind) => {
			let calls = 0
			const fallback = () => {
				calls++
				throw new Error('Private prefault invoked')
			}
			const hidden =
				kind === 'scalar'
					? new z.ZodPipe({ type: 'pipe', in: z.string(), out: z.string().prefault(fallback) })
					: new z.ZodPipe({
							type: 'pipe',
							in: z.object({ code: z.string() }),
							out: z.object({ code: z.string().prefault(fallback) }),
						})
			const tasks = zodTable('tasks', () => ({ title: z.string(), hidden }), {
				publicFields: ['title'],
			})
			const native = tasks.table
			const validator = native.validator
			const hiddenValidator = validator.fields.hidden
			const relations = defineRelations({ tasks }, () => ({}))
			expect(tasks.table).toBe(native)
			expect(tasks.table.validator).toBe(validator)
			expect(tasks.table.validator.fields.hidden).toBe(hiddenValidator)
			expect(getRelationMetadata(relations).tables.tasks.fields.hidden.kind).toBe(
				kind === 'scalar' ? 'string' : 'object',
			)
			const output = relations.tables.tasks.pageDto({})
			const page = {
				page: [{ _id: 'tasks:1', title: 'visible' }],
				isDone: true,
				continueCursor: '',
			}
			expect(output.parse(page)).toEqual(page)
			expect(output.safeParse({ ...page, page: [{ ...page.page[0], hidden: '' }] }).success).toBe(
				false,
			)
			expect(calls).toBe(0)
		},
	)
	test('direct private prefault remains unsupported at the native input boundary', () => {
		let calls = 0
		const tasks = zodTable(
			'tasks',
			() => ({
				title: z.string(),
				hidden: z.string().prefault(() => {
					calls++
					throw new Error('Direct prefault invoked')
				}),
			}),
			{ publicFields: ['title'] },
		)
		expect(() => verified({ tasks }, () => ({}))).toThrow(/Unsupported native validation form/)
		expect(calls).toBe(0)
	})
	test.each(['defaultValue', 'unexpected'] as const)(
		'unknown stored prefault %s accessor rejects without invocation',
		(key) => {
			const output = z.string().prefault('fallback')
			const tasks = zodTable(
				'tasks',
				() => ({
					title: z.string(),
					hidden: new z.ZodPipe({ type: 'pipe', in: z.string(), out: output }),
				}),
				{ publicFields: ['title'] },
			)
			let calls = 0
			const getter = () => {
				calls++
				return 'changed'
			}
			getter.toString = () =>
				Function.prototype.toString.call(
					Object.getOwnPropertyDescriptor(z.string().prefault('')._zod.def, 'defaultValue')!.get!,
				)
			Object.defineProperty(output._zod.def, key, {
				configurable: true,
				enumerable: true,
				get: getter,
			})
			expect(() => verified({ tasks }, () => ({}))).toThrow(/accessor/)
			expect(calls).toBe(0)
		},
	)
	test('regular expression and object checks survive repeated parsing', () => {
		const profile = z
			.object({ code: z.string().regex(/^valid$/g) })
			.refine((value) => value.code.length === 5)
		const boundary = zodTable('items', () => ({ profile }), { publicFields: ['profile'] })
		const registry = defineRelations({ items: boundary }, () => ({}))
		const output = registry.tables.items.pageDto({})
		const page = (code: string) => ({
			page: [{ _id: 'items:1', profile: { code } }],
			isDone: true,
			continueCursor: '',
		})
		for (let i = 0; i < 3; i++) {
			expect(output.safeParse(page('valid')).success).toBe(true)
			expect(output.safeParse(page('other')).success).toBe(false)
		}
	})
	test('array and union DTO graph mutation is isolated while captured refinements remain active', () => {
		const profile = z.object({ x: z.string().refine((value) => value === 'valid') })
		const list = z.array(profile)
		const choice = z.union([profile, z.string().min(3)])
		const boundary = zodTable('items', () => ({ list, choice }), {
			publicFields: ['list', 'choice'],
		})
		const registry = defineRelations({ items: boundary }, () => ({}))
		const output = registry.tables.items.pageDto({})
		const page = (x: string) => ({
			page: [{ _id: 'items:1', list: [{ x }], choice: { x } }],
			isDone: true,
			continueCursor: '',
		})
		expect(output.safeParse(page('valid')).success).toBe(true)
		expect(output.safeParse(page('invalid')).success).toBe(false)
		Reflect.set(profile.shape, 'x', z.number())
		expect(output.safeParse(page('valid')).success).toBe(true)
		expect(output.safeParse(page('invalid')).success).toBe(false)
		expect(() => registry.tables.items.pageDto({})).not.toThrow()
	})
	test('caller table map, declaration buckets and metadata cannot change later helpers', () => {
		const { tables } = fixture()
		let declaration: RelationDeclarations = {}
		const registry = defineRelations(tables, (r) => {
			const edges = {
				tasks: { referencedTask: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }) },
			}
			declaration = edges
			return edges
		})
		const before = registry.identity
		const metadata = getRelationMetadata(registry)
		const originalDto = tables.tasks.dto
		declaration.tasks = {}
		delete declaration.tasks
		Reflect.set(tables.tasks, 'dto', () => z.object({ replacement: z.string() }))
		tables.tasks.table.index('added_later', ['title'])
		expect(() => Reflect.set(metadata.tables.tasks.indexes[0], 'name', 'changed')).not.toThrow()
		expect(Reflect.set(metadata.tables.tasks.indexes[0], 'name', 'changed')).toBe(false)
		expect(Reflect.deleteProperty(metadata.declarations.tasks, 'referencedTask')).toBe(false)
		expect(Reflect.set(metadata.tables.tasks.fields.reference.native, 'type', 'any')).toBe(false)
		expect(registry.identity).toBe(before)
		expect(metadata.tables.tasks.indexes.some((index) => index.name === 'added_later')).toBe(false)
		expect(
			registry.tables.tasks.pageDto({ referencedTask: true }).safeParse({
				page: [{ _id: 'tasks:1', title: 't', referencedTask: null }],
				isDone: true,
				continueCursor: '',
			}).success,
		).toBe(true)
		tables.tasks.dto = originalDto
		expect(() => getRelationMetadata({ identity: before, version: 1 })).toThrow(/Unknown/)
	})
	test('identity changes with native fields, indexes, names, cardinality and output exposure', () => {
		const { tables, relations } = fixture()
		const changed = defineRelations(tables, (r) => ({
			tasks: { referencedTask: r.many.tasks({ from: r.tasks.reference, to: r.tasks._id }) },
		}))
		expect(changed.identity).not.toBe(relations.identity)
		expect(getRelationMetadata(relations).tables.tasks.fields.reference).toMatchObject({
			kind: 'union',
			optional: false,
			nullable: true,
			idTables: ['tasks'],
		})
	})
})

describe('compiler residual and native equality', () => {
	test('namespace, boolean controls, relations and server constraints AND together', () => {
		const { relations } = fixture()
		const schema = relations.tables.tasks.paginationOpts({
			count: true,
			referencedTask: { count: true },
		})
		const indexes = [{ name: 'by_count', fields: ['count', '_creationTime'] }]
		const result = compileFilters(
			schema,
			{
				numItems: 1,
				cursor: null,
				filters: { count: 1, fields: { count: { gte: 0 } }, referencedTask: { count: 2 } },
			},
			indexes,
			[],
			{ count: 2 },
		)
		expect(result.unsatisfiable).toBe(true)
		expect(JSON.stringify(result.residual)).toContain('relation')
		expect(result.bindings.get('count')).toBe(2)
		expect(
			compileFilters(
				schema,
				{ numItems: 1, cursor: null, filters: { referencedTask: { count: 2 } } },
				indexes,
			).index,
		).toBeNull()
	})
	test('longest contiguous prefix, stable ties and unknown explicit indexes', () => {
		const { tables } = fixture()
		const schema = tables.tasks.paginationOpts({ active: true, count: true, code: true })
		const indexes = [
			{ name: 'z', fields: ['active', 'count', 'code'] },
			{ name: 'a', fields: ['active', 'count'] },
			{ name: 'nonprefix', fields: ['code', 'count'] },
		]
		const args = { numItems: 1, cursor: null, filters: { active: false, count: 0 } }
		expect(compileFilters(schema, args, indexes).index?.name).toBe('a')
		expect(compileFilters(schema, args, [...indexes].reverse()).index?.name).toBe('a')
		expect(
			compileFilters(schema, { ...args, filters: { ...args.filters, code: '' } }, indexes).prefix,
		).toHaveLength(3)
		expect(() =>
			compileFilters(schema, args, indexes, [{ value: true, index: 'nonprefix' }]),
		).toThrow(/incompatible/)
		expect(() =>
			compileFilters(schema, args, indexes, [{ value: true, index: 'unknown' }]),
		).toThrow(/incompatible/)
		expect(
			compileFilters(schema, args, indexes, [
				{ value: null, index: 'unknown' },
				{ value: 0, index: 'a' },
				{ value: false, index: 'z' },
			]).index?.name,
		).toBe('a')
	})
	test('bigint, null and similarly printed scalar values never alias', () => {
		const native = zodTable('native', () => ({
			big: z.bigint(),
			nullable: z.number().nullable(),
			mixed: z.union([z.string(), z.number()]),
		}))
		const schema = native.paginationOpts({ big: true, nullable: true, mixed: true })
		const args = { numItems: 1, cursor: null, filters: { big: { in: [1n, 1n] }, nullable: null } }
		expect(
			compileFilters(schema, args, [{ name: 'by_big', fields: ['big'] }]).bindings.get('big'),
		).toBe(1n)
		expect(
			compileFilters(schema, args, [{ name: 'by_null', fields: ['nullable'] }]).prefix[0].value,
		).toBeNull()
		expect(
			compileFilters(
				schema,
				{ numItems: 1, cursor: null, filters: { and: [{ mixed: 1 }, { mixed: '1' }] } },
				[],
			).unsatisfiable,
		).toBe(true)
	})
})

test('shared selection objects are finite DAGs, not cycles', () => {
	const { relations } = fixture()
	const shared = { title: true } as const
	expect(
		relations.tables.tasks.paginationOpts({ referencedTask: shared, second: shared }),
	).toBeDefined()
	const sharedOutput = { referencedTask: true } as const
	expect(
		relations.tables.tasks.pageDto({ referencedTask: sharedOutput, second: sharedOutput }),
	).toBeDefined()
})

test('native nested output and selected relation filter validators reject real foreign table IDs', async () => {
	const { tables, relations } = fixture()
	const resultSchema = relations.tables.tasks.pageDto({ referencedTask: true, labels: true })
	const options = relations.tables.tasks.paginationOpts({
		referencedTask: { _id: true },
		labels: { _id: true },
	})
	const base = defineTestApp({
		schema: defineSchema({
			tasks: tables.tasks.table,
			labels: tables.labels.table,
			links: tables.links.table,
		}),
	})
	const app = base.defineModules({
		functions: {
			output: base.query({
				args: { wrong: v.boolean() },
				returns: zodToConvex(resultSchema),
				handler: async (ctx, args) => {
					const task = (await ctx.db.query('tasks').first())!
					const label = (await ctx.db.query('labels').first())!
					return {
						page: [
							{
								_id: task._id,
								title: task.title,
								referencedTask: { _id: args.wrong ? label._id : task._id, title: task.title },
								labels: {
									page: [{ _id: label._id, name: label.name }],
									isDone: true,
									continueCursor: '',
								},
							},
						],
						isDone: true,
						continueCursor: '',
					}
				},
			}),
			input: base.query({ args: { options: zodToConvex(options) }, handler: () => true }),
		},
	})
	const t = app.createTest()
	const [task, label] = await t.run(async (ctx) => [
		await ctx.db.insert('tasks', {
			title: 't',
			reference: null,
			active: false,
			count: 0,
			code: '',
			status: null,
		}),
		await ctx.db.insert('labels', { name: 'l', code: 'l' }),
	])
	await expect(t.query(app.api.functions.output, { wrong: false })).resolves.toMatchObject({
		isDone: true,
	})
	await expect(t.query(app.api.functions.output, { wrong: true })).rejects.toThrow()
	await expect(
		t.query(app.api.functions.input, {
			options: {
				numItems: 1,
				cursor: null,
				filters: { referencedTask: { _id: task }, labels: { some: { _id: label } } },
			},
		}),
	).resolves.toBe(true)
	for (const filters of [{ referencedTask: { _id: label } }, { labels: { none: { _id: task } } }])
		await expect(
			// @ts-expect-error deliberately send foreign-table IDs to exercise native validation
			t.query(app.api.functions.input, { options: { numItems: 1, cursor: null, filters } }),
		).rejects.toThrow()
})

function nativeGuardFixture() {
	const items = zodTable(
		'items',
		() => ({
			text: z.string(),
			vector: z.array(z.number()),
			nested: z.object({
				list: z.array(z.union([z.literal('a'), z.literal('b')])).optional(),
				map: z.record(z.string(), z.number()),
			}),
		}),
		{ publicFields: ['text'] },
	)
	items.table
		.index('by_text', ['text'])
		.index('staged_text', { fields: ['text'], staged: true })
		.searchIndex('search_text', { searchField: 'text', filterFields: ['nested.list'] })
		.searchIndex('staged_search', { searchField: 'text', staged: true })
		.vectorIndex('vector', { vectorField: 'vector', dimensions: 3, filterFields: ['text'] })
		.vectorIndex('staged_vector', { vectorField: 'vector', dimensions: 3, staged: true })
	// Convex 1.46 strips this runtime @internal method from declarations.
	const stage = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(items.table), 'staged')!.value
	stage.call(items.table, {
		text: v.string(),
		vector: v.array(v.number()),
		nested: v.object({
			list: v.optional(v.array(v.union(v.literal('a'), v.literal('b')))),
			map: v.record(v.string(), v.number()),
		}),
	})
	return items
}

test('native structural mutations leave captured executor semantics stable including staged and nested data', () => {
	const mutations: ((items: ReturnType<typeof nativeGuardFixture>) => void)[] = [
		(items) => {
			Reflect.set(items, 'table', nativeGuardFixture().table)
		},
		(items) => {
			Reflect.set(items.table.validator.fields.nested.fields.list, 'isOptional', 'required')
		},
		(items) => {
			Reflect.set(
				items.table.validator.fields.nested.fields.list.element.members[0],
				'value',
				'changed',
			)
		},
		(items) => {
			Reflect.set(items.table.validator.fields.nested.fields.map, 'key', v.literal('changed'))
		},
		(items) => {
			Reflect.set(items.table.validator.fields.nested.fields.map, 'value', v.string())
		},
		(items) => {
			Reflect.set(items.table.validator.fields.vector, 'element', v.string())
		},
		(items) => {
			Reflect.set(items.table.validator.fields.nested.fields, 'added', v.string())
		},
		(items) => {
			Reflect.deleteProperty(items.table.validator.fields.nested.fields, 'map')
		},
		(items) => {
			Reflect.set(items.table.validator.fields, 'text', v.string())
		},
		(items) => {
			Reflect.set(items.table, 'validator', v.object({ text: v.string() }))
		},
		...[
			'indexes',
			'stagedDbIndexes',
			'searchIndexes',
			'stagedSearchIndexes',
			'vectorIndexes',
			'stagedVectorIndexes',
		].flatMap((key) => [
			(items: ReturnType<typeof nativeGuardFixture>) => {
				Reflect.set(
					Object.getOwnPropertyDescriptor(items.table, key)!.value[0],
					'indexDescriptor',
					'changed',
				)
			},
			(items: ReturnType<typeof nativeGuardFixture>) => {
				Object.getOwnPropertyDescriptor(items.table, key)!.value.pop()
			},
		]),
		(items) => {
			Object.getOwnPropertyDescriptor(items.table, 'indexes')!.value[0].fields.push('vector')
		},
		(items) => {
			Object.getOwnPropertyDescriptor(items.table, 'searchIndexes')!.value[0].filterFields.push(
				'text',
			)
		},
		(items) => {
			Object.getOwnPropertyDescriptor(items.table, 'vectorIndexes')!.value[0].dimensions = 4
		},
		(items) => {
			Reflect.set(
				Object.getOwnPropertyDescriptor(items.table, 'stagedValidator')!.value.fields,
				'text',
				v.number(),
			)
		},
		(items) => {
			Object.setPrototypeOf(items.table.validator.fields.text, {})
		},
	]
	for (const mutate of mutations) {
		const items = nativeGuardFixture()
		const relations = defineRelations({ items }, () => ({}))
		const executor = getRelationExecutor(relations)
		executor.project('items', { _id: 'items:1', text: 'valid' }, () => true)
		mutate(items)
		expect(executor.project('items', { _id: 'items:1', text: 'valid' }, () => true)).toEqual({
			_id: 'items:1',
			text: 'valid',
		})
	}
})

test('native getters and custom prototypes fail closed without executing caller accessors', () => {
	for (const initial of [true, false])
		for (const site of ['table', 'validator', 'field', 'index', 'prototype']) {
			const items = nativeGuardFixture()
			const executor = initial ? undefined : getRelationExecutor(verified({ items }, () => ({})))
			let calls = 0
			const getter = {
				configurable: true,
				enumerable: true,
				get: () => {
					calls++
					throw new Error('caller getter executed')
				},
			}
			if (site === 'table') Object.defineProperty(items.table, 'validator', getter)
			if (site === 'validator') Object.defineProperty(items.table.validator, 'json', getter)
			if (site === 'field')
				Object.defineProperty(items.table.validator.fields.nested.fields, 'list', getter)
			if (site === 'index')
				Object.defineProperty(
					Object.getOwnPropertyDescriptor(items.table, 'indexes')!.value[0],
					'fields',
					getter,
				)
			if (site === 'prototype')
				Object.setPrototypeOf(items.table.validator, {
					get json() {
						calls++
						throw new Error('caller prototype executed')
					},
				})
			if (initial) expect(() => verified({ items }, () => ({}))).toThrow(/native|Native/)
			else
				expect(executor!.project('items', { _id: 'items:1', text: 'valid' }, () => true)).toEqual({
					_id: 'items:1',
					text: 'valid',
				})
			expect(calls).toBe(0)
		}
})

test('native prototype getter replacement is rejected on first use and isolated after capture', () => {
	for (const initial of [true, false]) {
		const items = nativeGuardFixture()
		const executor = initial ? undefined : getRelationExecutor(verified({ items }, () => ({})))
		const prototype = Object.getPrototypeOf(items.table.validator.fields.text)
		const before = Object.getOwnPropertyDescriptor(prototype, 'json')!
		let calls = 0
		try {
			Object.defineProperty(prototype, 'json', {
				...before,
				get: () => {
					calls++
					throw new Error('caller prototype executed')
				},
			})
			if (initial) expect(() => verified({ items }, () => ({}))).toThrow(/native|Native/)
			else
				expect(executor!.project('items', { _id: 'items:1', text: 'valid' }, () => true)).toEqual({
					_id: 'items:1',
					text: 'valid',
				})
			expect(calls).toBe(0)
		} finally {
			Object.defineProperty(prototype, 'json', before)
		}
	}
})

test('native table ownership is captured before the caller declaration runs', () => {
	const items = nativeGuardFixture()
	const original = items.table
	const replacement = nativeGuardFixture()
	const relations = defineRelations({ items }, () => {
		Reflect.set(items, 'table', replacement.table)
		return {}
	})
	const executor = getRelationExecutor(relations)
	expect(() => executor.assertSchema({ items: original })).not.toThrow()
	expect(() => executor.assertSchema({ items: replacement.table })).toThrow(/ownership/)
	expect(() => executor.assertSchema({})).toThrow(/ownership/)
	expect(() => executor.assertSchema({ items: original, extra: original })).toThrow(/ownership/)
	let reads = 0
	const accessor = {
		get items() {
			reads++
			return original
		},
	}
	expect(() => executor.assertSchema(accessor)).toThrow(/ownership/)
	expect(reads).toBe(0)
	expect(executor.project('items', { _id: 'items:1', text: 'valid' }, () => true)).toEqual({
		_id: 'items:1',
		text: 'valid',
	})
})

test('execution performs zero descriptor reads of the original semantic graph', () => {
	const text = z.string().regex(/valid/g)
	const items = zodTable('items', () => ({ text }), { publicFields: ['text'] })
	const others = zodTable('others', () => ({ text }), { publicFields: ['text'] })
	const relations = defineRelations({ items, others }, () => ({}))
	const executor = getRelationExecutor(relations)
	const output = relations.tables.items.pageDto({}).clone()
	const targets = new Set<object>([
		text._zod,
		text._zod.def,
		items.table,
		items.table.validator.fields.text,
	])
	const original = Object.getOwnPropertyDescriptor
	for (let boundary = 0; boundary < 2; boundary++) {
		const reads = new Map<object, Map<PropertyKey, number>>()
		Object.getOwnPropertyDescriptor = (object, key) => {
			let counts = reads.get(object)
			if (!counts) reads.set(object, (counts = new Map()))
			counts.set(key, (counts.get(key) ?? 0) + 1)
			return original(object, key)
		}
		try {
			executor.project('items', { _id: 'items:1', text: 'valid' }, () => true)
		} finally {
			Object.getOwnPropertyDescriptor = original
		}
		for (const target of targets) expect(reads.has(target)).toBe(false)
	}
	Reflect.set(text._zod.def, 'checks', [])
	expect(executor.project('items', { _id: 'items:1', text: 'valid' }, () => true)).toEqual({
		_id: 'items:1',
		text: 'valid',
	})
	expect(output.safeParse({ page: [], isDone: true, continueCursor: '' }).success).toBe(true)
})

test('snapshot regex validation ignores caller lastIndex changes during construction and parsing', () => {
	const expression = /valid/g
	const text = z.string().regex(expression)
	const items = zodTable('items', () => ({ text }), { publicFields: ['text'] })
	const relations = defineRelations({ items }, () => {
		expression.lastIndex = 2
		return {}
	})
	const executor = getRelationExecutor(relations)
	for (const lastIndex of [0, 4, 9]) {
		expression.lastIndex = lastIndex
		expect(() =>
			executor.project('items', { _id: 'items:1', text: 'valid' }, () => true),
		).not.toThrow()
	}
})
