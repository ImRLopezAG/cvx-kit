import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { defineTestApp } from 'convex-test'
import {
	defineRelations,
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
		expect(compile({ count: { in: [1, 2] } }).index).toBeNull()
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
const unchecked = defineRelations as (
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
				defineRelations({ owners, children }, (r) => ({
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
			defineRelations({ ...tables, junction }, (r) => ({
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
			defineRelations({ ...tables, labels, junction }, (r) => ({
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
			expect(() => defineRelations({ items: boundary }, () => ({}))).toThrow(/accessor/)
			expect(reads).toBe(0)
		}
	})
	test('refined object capture preserves checks and rejects drift before first cloned parse', async () => {
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
			expect(schema.safeParse(empty).success).toBe(false)
			expect((await schema.safeParseAsync(empty)).success).toBe(false)
			expect(() => zodToConvex(schema)).toThrow(/mutat/)
		}
		expect(options.safeParse({ numItems: 1, cursor: null }).success).toBe(false)
		expect(() => zodToConvex(options)).toThrow(/mutat/)
		expect(() => registry.tables.items.pageDto({})).toThrow(/mutat/)
	})
	test('actual native stored document must agree with boundary kinds, optionality and ID brands', () => {
		for (const field of [v.number(), v.optional(v.string()), v.id('other')]) {
			const boundary = zodTable('items', () => ({ code: z.string() }))
			Reflect.set(boundary, 'table', defineTable({ code: field }).index('by_code', ['code']))
			expect(() => defineRelations({ items: boundary }, () => ({}))).toThrow(/document|boundary/)
		}
		const boundary = zodTable('items', (id) => ({ owner: id('items') }))
		Reflect.set(boundary, 'table', defineTable({ owner: v.id('other') }))
		expect(() => defineRelations({ items: boundary }, () => ({}))).toThrow(/document|boundary/)
	})
	test('nested DTO mutation rejects later helpers and already-created output schemas', () => {
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
			expect(() => registry.tables.items.pageDto({})).toThrow(/mutat/)
			expect(() => registry.tables.items.paginationOpts({})).toThrow(/mutat/)
			expect(
				output.safeParse({
					page: [{ _id: 'items:1', profile: { x: 'ok', secret: 'leak' } }],
					isDone: true,
					continueCursor: '',
				}).success,
			).toBe(false)
			expect(() => zodToConvex(output)).toThrow(/mutat/)
			for (const schema of [output, clonedOutput])
				expect(schema.safeParse({ page: [], isDone: true, continueCursor: '' }).success).toBe(false)
			expect(options.safeParse({ numItems: 1, cursor: null }).success).toBe(false)
			expect(registry.identity).toBe(identity)
		}
	})
	test('array element, union options and custom check mutations are detected', () => {
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
			expect(() => registry.tables.items.pageDto({})).toThrow(/mutat/)
			expect(output.safeParse({ page: [], isDone: true, continueCursor: '' }).success).toBe(false)
		}
	})
	test('unsupported dynamic or value-changing DTO nodes fail closed', () => {
		for (const field of [
			z.string().default('default'),
			z.string().transform((value) => value.length),
			z.lazy(() => z.string()),
			z.any(),
		]) {
			const boundary = zodTable('items', () => ({ field }), { publicFields: ['field'] })
			expect(() => defineRelations({ items: boundary }, () => ({}))).toThrow(/Unsupported/)
		}
	})
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
	test('array and union DTO graph mutation rejects while original refinements remain active', () => {
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
		expect(output.safeParse(page('valid')).success).toBe(false)
		expect(() => registry.tables.items.pageDto({})).toThrow(/mutat/)
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
