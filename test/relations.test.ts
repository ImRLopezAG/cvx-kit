import { describe, expect, test } from 'vitest'
import { k, type KFields, type KObject, type KType } from '../src/k'
import { defineSchema, defineTable, type TableDefinition } from 'convex/server'
import { v } from 'convex/values'
import { defineTestApp } from 'convex-test'
import {
	defineRelations,
	withFieldGroups,
	verifyRelations,
	getRelationExecutor,
	getRelationMetadata,
	type RelationTables,
	type RelationBuilder,
	type RelationDeclarations,
	type RelationRegistry,
} from '../src/relations'
import { compileFilters } from '../src/querying/filters'
import { kTable } from '../src/table'

function fixture() {
	const tasks = kTable(
		'tasks',
		{
			title: k.string(),
			reference: k.id('tasks').nullable(),
			active: k.boolean(),
			count: k.number(),
			code: k.string(),
			status: k.enum(['open', 'done']).nullable(),
		},
		{ publicFields: ['title'] },
	)
	const labels = kTable(
		'labels',
		{ name: k.string(), code: k.string() },
		{
			publicFields: ['name'],
		},
	)
	const links = kTable('links', { taskId: k.id('tasks'), labelId: k.id('labels') })
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
		expect(schema.validator.kind).toBe('object')
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
		const compile = (filters: k.input<typeof schema>['filters']) =>
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
// SAFETY: this negative fixture deliberately bypasses static index or relation guards to test runtime rejection.
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
			const owners = kTable('owners', { code: k.string() })
			const children = kTable('children', { owner: k.string(), extra: k.string() })
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
		const parents = kTable('parents', { status: k.enum(['open', 'done']).nullable() })
		const targets = kTable('targets', {
			status: k.enum(['done', 'open']),
			bad: k.enum(['open', 'other']).nullable(),
		})
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
		const links2 = kTable('links2', { taskId: k.id('tasks'), labelId: k.id('labels') })
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
		const junction = kTable('junction', { taskId: k.id('tasks'), labelCode: k.string() })
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
		const labels = kTable('labels', { name: k.string(), code: k.string() })
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
		for (const schema of [opts, opts.describe('derived')]) {
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
		const output = relations.tables.tasks.pageDto as (selection: TestSelection) => KType
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
	// k form of v1's mutation-isolation proofs: declared schemas are frozen, so a caller cannot
	// change what the executor projects or what a helper returns after materialisation.
	test('a captured schema cannot be mutated after materialisation, and projection is unchanged', () => {
		const profile = k.object({ text: k.string() })
		const items = kTable('items', { profile, secret: k.string() }, { publicFields: ['profile'] })
		const registry = defineRelations({ items }, () => ({}))
		const executor = getRelationExecutor(registry)
		const row = { _id: 'items:1', profile: { text: 'ok' }, secret: 's' }
		const before = registry.identity
		expect(executor.project('items', row, () => true)).toEqual({
			_id: 'items:1',
			profile: { text: 'ok' },
		})
		expect(() => Object.assign(profile.shape, { secret: k.string() })).toThrow(TypeError)
		expect(() => Object.assign(items.publicDto.shape, { secret: k.string() })).toThrow(TypeError)
		expect(() => Reflect.deleteProperty(profile.shape, 'text')).not.toThrow()
		expect(Object.keys(profile.shape)).toEqual(['text'])
		expect(executor.project('items', row, () => true)).toEqual({
			_id: 'items:1',
			profile: { text: 'ok' },
		})
		expect(() =>
			executor.project('items', { ...row, profile: { text: 'ok', secret: 's' } }, () => true),
		).toThrow()
		const page = objectOf(registry.tables.items.pageDto({}))
		expect(() => Object.assign(page.shape, { extra: k.string() })).toThrow(TypeError)
		expect(registry.identity).toBe(before)
	})
	test('helper inputs mutated after use do not change later helpers or the registry', () => {
		const items = kTable(
			'items',
			{ title: k.string(), secret: k.string(), note: k.string() },
			{
				publicFields: ['title'],
			},
		)
		const groups = { private: ['secret'] }
		const registry = defineRelations({ items: withFieldGroups(items, groups) }, () => ({}))
		groups.private.push('note')
		groups.private[0] = 'title'
		const selection = { title: true } as const
		const first = registry.tables.items.paginationOpts(selection)
		Reflect.set(selection, 'secret', true)
		const second = registry.tables.items.paginationOpts({ title: true })
		expect(second).toBe(first)
		const unknown = { numItems: 1, cursor: null, filters: { secret: 's' } }
		expect(first.safeParse(unknown).success).toBe(false)
		expect(getRelationMetadata(registry).tables.items.fieldGroups).toEqual({ private: ['secret'] })
		const page = {
			page: [{ _id: 'items:1', title: 't', secret: 's' }],
			isDone: true,
			continueCursor: '',
		}
		expect(
			registry.tables.items.pageDto({}, { fieldGroups: { private: 'required' } }).safeParse(page)
				.success,
		).toBe(true)
	})
	test('new registries adopt valid source refinement and index changes', () => {
		const text = k.string().refine((value) => value === 'valid')
		const items = kTable('items', { text }, { publicFields: ['text'] })
		// Each table is captured on first use; verification uses every table now.
		const first = verified({ items }, () => ({}))
		items.table.index('late', ['text'])
		const second = defineRelations({ items }, () => ({}))
		const page = { page: [{ _id: 'items:1', text: 'valid' }], isDone: true, continueCursor: '' }
		expect(first.tables.items.pageDto({}).safeParse(page).success).toBe(true)
		// v1 also replaced the Zod check function between registries; k records are immutable, so
		// both registries apply the declared refinement.
		expect(second.tables.items.pageDto({}).safeParse(page).success).toBe(true)
		expect(
			second.tables.items.pageDto({}).safeParse({ ...page, page: [{ ...page.page[0], text: 'x' }] })
				.success,
		).toBe(false)
		expect(getRelationMetadata(first).tables.items.indexes).toEqual([])
		expect(getRelationMetadata(second).tables.items.indexes).toEqual([
			{ name: 'late', fields: ['text'] },
		])
	})
	test('actual native stored document must agree with boundary kinds, optionality and ID brands', () => {
		for (const field of [v.number(), v.optional(v.string()), v.id('other')]) {
			const boundary = kTable('items', { code: k.string() })
			replaceTable(boundary, defineTable({ code: field }).index('by_code', ['code']))
			expect(() => verified({ items: boundary }, () => ({}))).toThrow(/document|boundary/)
		}
		const boundary = kTable('items', { owner: k.id('items') })
		replaceTable(boundary, defineTable({ owner: v.id('other') }))
		expect(() => verified({ items: boundary }, () => ({}))).toThrow(/document|boundary/)
	})
	test('unsupported dynamic or value-changing DTO nodes fail closed', () => {
		// v1's pipe, prefault, coercion and lazy nodes have no k form; k.trim and overwrite are the k
		// value-changing nodes a stored field may hold, and a DTO still rejects them.
		for (const field of [
			k.string().default('default'),
			k.string().trim(),
			k.string().overwrite((value) => value),
			k.any(),
		]) {
			const boundary = kTable('items', { field }, { publicFields: ['field'] })
			expect(() => verified({ items: boundary }, () => ({}))).toThrow(/Unsupported/)
		}
		// Transforms and pipes are rejected by the table itself (KTD4).
		expect(() =>
			// SAFETY: the type already rejects a transform field; the runtime check is the subject.
			kTable('items', { field: k.string().transform((value) => value.length) } as never),
		).toThrow(/transform/)
	})
	test.each([
		// v2 stored fields cannot transform or coerce (KTD4); normalisers and defaults stand in.
		['normaliser', k.number().overwrite((value) => value + 1)],
		['default', k.string().default('fallback')],
		['check', k.number().refine(() => true)],
	] as const)(
		'private stored %s nodes preserve construction and strict public DTOs',
		(_name, hidden) => {
			const tasks = kTable(
				'tasks',
				{ title: k.string(), hidden },
				{
					publicFields: ['title'],
				},
			)
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
	test('regular expression and object checks survive repeated parsing', () => {
		const profile = k
			.object({ code: k.string().regex(/^valid$/g) })
			.refine((value) => value.code.length === 5)
		const boundary = kTable('items', { profile }, { publicFields: ['profile'] })
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
		const profile = k.object({ x: k.string().refine((value) => value === 'valid') })
		const list = k.array(profile)
		const choice = k.union([profile, k.string().min(3)])
		const boundary = kTable(
			'items',
			{ list, choice },
			{
				publicFields: ['list', 'choice'],
			},
		)
		const registry = defineRelations({ items: boundary }, () => ({}))
		const output = registry.tables.items.pageDto({})
		const page = (x: string) => ({
			page: [{ _id: 'items:1', list: [{ x }], choice: { x } }],
			isDone: true,
			continueCursor: '',
		})
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
		Reflect.set(tables.tasks, 'dto', () => k.object({ replacement: k.string() }))
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
		const native = kTable('native', {
			big: k.int64(),
			nullable: k.number().nullable(),
			mixed: k.union([k.string(), k.number()]),
		})
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
				returns: resultSchema.validator,
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
			input: base.query({ args: { options: options.validator }, handler: () => true }),
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
	const items = kTable(
		'items',
		{
			text: k.string(),
			vector: k.array(k.number()),
			nested: k.object({
				list: k.array(k.union([k.literal('a'), k.literal('b')])).optional(),
				map: k.record(k.string(), k.number()),
			}),
		},
		{ publicFields: ['text'] },
	)
	// k shares its immutable native leaf validators between schemas. These tests mutate the native
	// graph, so the table owns a fresh, equal copy instead of the boundary's memoised one.
	const optionalNumber = () => v.optional(v.number())
	replaceTable(
		items,
		defineTable(
			v.object({
				text: v.string(),
				vector: v.array(v.number()),
				nested: v.object({
					list: v.optional(v.array(v.union(v.literal('a'), v.literal('b')))),
					map: v.record(v.string(), v.number()),
				}),
				createdAt: optionalNumber(),
				updatedAt: optionalNumber(),
				archivedAt: optionalNumber(),
			}),
		),
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
	const text = k.string().regex(/valid/g)
	const items = kTable('items', { text }, { publicFields: ['text'] })
	const others = kTable('others', { text }, { publicFields: ['text'] })
	const relations = defineRelations({ items, others }, () => ({}))
	const executor = getRelationExecutor(relations)
	const output = relations.tables.items.pageDto({})
	// v1 also watched the Zod internals of `text`; a k schema is a plain record chain.
	const targets = new Set<object>([text, items.table, items.table.validator.fields.text])
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
	expect(executor.project('items', { _id: 'items:1', text: 'valid' }, () => true)).toEqual({
		_id: 'items:1',
		text: 'valid',
	})
	expect(output.safeParse({ page: [], isDone: true, continueCursor: '' }).success).toBe(true)
})

test('snapshot regex validation ignores caller lastIndex changes during construction and parsing', () => {
	const expression = /valid/g
	const text = k.string().regex(expression)
	const items = kTable('items', { text }, { publicFields: ['text'] })
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

/** A kTable's `table` is a read-only accessor; an own property stands in for a caller-replaced table. */
function replaceTable(boundary: { readonly tableName: string }, table: TableDefinition): void {
	Object.defineProperty(boundary, 'table', { value: table, configurable: true })
}

function objectOf(schema: KType): KObject<KFields> {
	// SAFETY: pageDto builds a k object; its declared type is the page's KSchema.
	return schema as KObject<KFields>
}
