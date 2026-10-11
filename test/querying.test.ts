import { anyApi } from 'convex/server'
import { authenticatedFixture } from './fixture-querying/auth'
import { largeRegistry } from './fixture-querying/large-registry'
import { privateStoredFixture, privatePrefaultFixture } from './fixture-querying/private-stored'
import { describe, expect, test } from 'vite-plus/test'
import { stream } from 'convex-helpers/server/stream'
import { compareValues, getDocumentSize } from 'convex/values'
import { createPlanner } from '../src/querying/planner'
import { createCursorCodec, type CursorBinding } from '../src/querying/cursors'
import { createQueryEngine } from '../src/querying'
import { MAX_DOCUMENT_BYTES } from '../src/querying/security'
import {
	declarations,
	harness,
	seed,
	managed,
	observed,
	cursor,
	scope,
} from './fixture-querying/scalar'
import type { FilterScalar, ScalarFilters, ScalarSelection } from '../src/querying/filters'
import type { DM } from './fixture-querying/scalar'
import type { DataModelFromSchemaDefinition, DocumentByName } from 'convex/server'

function sorted<Row extends { _id: string; _creationTime: number }>(
	rows: Row[],
	fields: (keyof Row)[],
	order: 'asc' | 'desc',
) {
	return [...rows].sort((a, b) => {
		// SAFETY: system keys are guaranteed by Row and supplied native field keys are keyof Row.
		for (const field of [...fields, '_creationTime', '_id'] as (keyof Row)[]) {
			const x = a[field],
				y = b[field]
			if (x === y) continue
			return (x! < y! ? -1 : 1) * (order === 'asc' ? 1 : -1)
		}
		return 0
	})
}

describe('U5 actual helper scalar engine', () => {
	test('private pipe prefault outputs retain raw native string filtering and strict DTOs', async () => {
		const f = privatePrefaultFixture()
		const input = { numItems: 1, cursor: null, filters: { hidden: '' } }
		expect(f.tasks.paginationOpts({ hidden: true }).parse(input)).toEqual(input)
		const rows = await f.t.run(async (ctx) => {
			const result: DocumentByName<DataModelFromSchemaDefinition<typeof f.schema>, 'tasks'>[] = []
			for (const hidden of ['', 'other', '', 'fallback']) {
				const id = await ctx.db.insert('tasks', {
					title: `row${result.length}`,
					hidden,
					nested: { code: hidden },
				})
				result.push((await ctx.db.get(id))!)
			}
			return result
		})
		await f.t.run(async (ctx) => {
			const o = observed<DataModelFromSchemaDefinition<typeof f.schema>>(ctx.db)
			const q = f.querying(managed(o.raw)).tasks.when(true, 'by_hidden')
			const page = await q.paginate({ numItems: 100, cursor: null, filters: { hidden: '' } })
			expect(page.page).toEqual(
				rows.filter((r) => r.hidden === '').map((r) => ({ _id: r._id, title: r.title })),
			)
			expect(page.isDone).toBe(true)
			expect(f.relations.tables.tasks.pageDto({}).parse(page)).toEqual(page)
			expect(o.counts).toEqual({ next: 3, returned: 2, ranges: 1, gets: 0, closes: 1 })
			const server = await q.where({ hidden: 'fallback' }).paginate({ numItems: 100, cursor: null })
			expect(server.page).toEqual(
				rows.filter((r) => r.hidden === 'fallback').map((r) => ({ _id: r._id, title: r.title })),
			)
			expect(o.counts).toEqual({ next: 5, returned: 3, ranges: 2, gets: 0, closes: 2 })
			const before = { ...o.counts }
			await expect(
				q.paginate({ numItems: 1, cursor: null, filters: JSON.parse('{"hidden":1}') }),
			).rejects.toThrow()
			expect(o.counts).toEqual(before)
		})
		expect(f.calls.prefault).toBe(0)
	}, 10000)
	test('pipe prefault graph mutations fail cached execution and after awaited policy before more reads', async () => {
		const mutations = [
			(f: ReturnType<typeof privatePrefaultFixture>) =>
				Reflect.set(f.tasks.schema.shape, 'hidden', f.tasks.schema.shape.title),
			(f: ReturnType<typeof privatePrefaultFixture>) =>
				Object.defineProperty(f.output._zod.def, 'defaultValue', {
					get: () => 'changed',
					enumerable: true,
					configurable: true,
				}),
			(f: ReturnType<typeof privatePrefaultFixture>) =>
				Reflect.set(f.output._zod.def.innerType._zod, 'def', { type: 'number' }),
			(f: ReturnType<typeof privatePrefaultFixture>) =>
				Reflect.set(f.hidden._zod.def, 'out', f.hidden._zod.def.in),
			(f: ReturnType<typeof privatePrefaultFixture>) =>
				Reflect.set(f.nestedOutput.shape, 'code', f.tasks.schema.shape.title),
			(f: ReturnType<typeof privatePrefaultFixture>) =>
				Object.defineProperty(f.nestedOutput.shape.code._zod.def, 'defaultValue', {
					get: () => 'changed',
					enumerable: true,
					configurable: true,
				}),
			(f: ReturnType<typeof privatePrefaultFixture>) =>
				Reflect.set(f.nestedOutput.shape.code._zod.def.innerType._zod, 'def', { type: 'number' }),
		]
		for (const mutate of mutations) {
			const f = privatePrefaultFixture()
			await f.t.run(async (ctx) => {
				await ctx.db.insert('tasks', { title: 'visible', hidden: '', nested: { code: '' } })
				const o = observed<DataModelFromSchemaDefinition<typeof f.schema>>(ctx.db)
				const q = f.querying(managed(o.raw)).tasks.where({ hidden: '' })
				await q.paginate({ numItems: 1, cursor: null })
				const before = { ...o.counts }
				mutate(f)
				await expect(q.paginate({ numItems: 1, cursor: null })).rejects.toThrow(/mutat/)
				expect(o.counts).toEqual(before)
				expect(() =>
					createQueryEngine({ schema: f.schema, relations: f.relations, cursor }),
				).toThrow(/mutat/)
			})
			expect(f.calls.prefault).toBe(0)
		}
		for (const mutate of mutations) {
			const f = privatePrefaultFixture()
			await f.t.run(async (ctx) => {
				for (let i = 0; i < 2; i++)
					await ctx.db.insert('tasks', { title: `visible${i}`, hidden: '', nested: { code: '' } })
				const o = observed<DataModelFromSchemaDefinition<typeof f.schema>>(ctx.db)
				const q = f
					.querying(
						managed(o.raw, {
							tasks: {
								read: async () => {
									await Promise.resolve()
									mutate(f)
									return true
								},
							},
						}),
					)
					.tasks.where({ hidden: '' })
				await expect(q.paginate({ numItems: 100, cursor: null })).rejects.toThrow(
					'Query execution failed',
				)
				expect(o.counts).toEqual({ next: 1, returned: 1, ranges: 1, gets: 0, closes: 1 })
			})
			expect(f.calls.prefault).toBe(0)
		}
	}, 10000)
	test('private stored parsers never run during native numeric/string filtering and strict projection', async () => {
		const f = privateStoredFixture()
		const rows = await f.t.run(async (ctx) => {
			const rows = []
			for (let i = 0; i < 4; i++) {
				const data: Omit<
					DocumentByName<DataModelFromSchemaDefinition<typeof f.schema>, 'tasks'>,
					'_id' | '_creationTime'
				> = {
					title: `row${i}`,
					numeric: i % 2,
					text: i % 2 ? 'yes' : '',
					coerced: i,
				}
				if (i % 2) data.fallback = 'stored'
				const id = await ctx.db.insert('tasks', data)
				rows.push((await ctx.db.get(id))!)
			}
			return rows
		})
		await f.t.run(async (ctx) => {
			const o = observed<DataModelFromSchemaDefinition<typeof f.schema>>(ctx.db)
			const q = f.querying(managed(o.raw)).tasks
			const page = await q
				.when(true, 'by_numeric')
				.where({ numeric: 1, text: 'yes', coerced: { gte: 1 }, fallback: { exists: true } })
				.paginate({ numItems: 100, cursor: null })
			expect(page.page).toEqual(
				rows
					.filter(
						(r) =>
							r.numeric === 1 && r.text === 'yes' && r.coerced >= 1 && Object.hasOwn(r, 'fallback'),
					)
					.map((r) => ({ _id: r._id, title: r.title })),
			)
			expect(o.counts).toEqual({ next: 3, returned: 2, ranges: 1, gets: 0, closes: 1 })
			const textPage = await q
				.when(true, 'by_text')
				.where({ text: '', fallback: { exists: false } })
				.paginate({ numItems: 100, cursor: null })
			expect(textPage.page).toEqual(
				rows
					.filter((r) => r.text === '' && !Object.hasOwn(r, 'fallback'))
					.map((r) => ({ _id: r._id, title: r.title })),
			)
			expect(o.counts).toEqual({ next: 6, returned: 4, ranges: 2, gets: 0, closes: 2 })
			const before = { ...o.counts }
			await expect(
				q.paginate({ numItems: 100, cursor: null, filters: JSON.parse('{"coerced":"1"}') }),
			).rejects.toThrow()
			expect(o.counts).toEqual(before)
		})
		expect(f.calls).toEqual({ transform: 0, default: 0, coercion: 0 })
	}, 10000)
	test('private stored graph mutations reject cached execution and live post-policy projection', async () => {
		for (const mutate of [
			(f: ReturnType<typeof privateStoredFixture>) =>
				Reflect.set(f.numeric._zod.def.in._zod, 'def', { type: 'string' }),
			(f: ReturnType<typeof privateStoredFixture>) =>
				Reflect.set(f.text._zod.def.out._zod.def, 'transform', () => 'changed'),
			(f: ReturnType<typeof privateStoredFixture>) =>
				Object.defineProperty(f.fallback._zod.def, 'defaultValue', {
					get: () => 'changed',
					enumerable: true,
					configurable: true,
				}),
			(f: ReturnType<typeof privateStoredFixture>) =>
				Reflect.set(f.coerced._zod.def, 'coerce', false),
			(f: ReturnType<typeof privateStoredFixture>) =>
				Reflect.set(f.fallback._zod.def.innerType._zod, 'def', { type: 'number' }),
		]) {
			const f = privateStoredFixture()
			await f.t.run(async (ctx) => {
				await ctx.db.insert('tasks', { title: 'visible', numeric: 1, text: 'yes', coerced: 1 })
				const o = observed<DataModelFromSchemaDefinition<typeof f.schema>>(ctx.db)
				const q = f.querying(managed(o.raw)).tasks.where({ numeric: 1 })
				await q.paginate({ numItems: 1, cursor: null })
				const before = { ...o.counts }
				mutate(f)
				await expect(q.paginate({ numItems: 1, cursor: null })).rejects.toThrow(/mutat/)
				expect(o.counts).toEqual(before)
				expect(() =>
					createQueryEngine({ schema: f.schema, relations: f.relations, cursor }),
				).toThrow(/mutat/)
			})
			expect(f.calls).toEqual({ transform: 0, default: 0, coercion: 0 })
		}
		const f = privateStoredFixture()
		await f.t.run(async (ctx) => {
			await ctx.db.insert('tasks', { title: 'visible', numeric: 1, text: 'yes', coerced: 1 })
			const o = observed<DataModelFromSchemaDefinition<typeof f.schema>>(ctx.db)
			const q = f
				.querying(
					managed(o.raw, {
						tasks: {
							read: async () => {
								Reflect.set(f.numeric._zod.def.in._zod, 'def', { type: 'string' })
								return true
							},
						},
					}),
				)
				.tasks.where({ numeric: 1 })
			await expect(q.paginate({ numItems: 1, cursor: null })).rejects.toThrow(
				'Query execution failed',
			)
			expect(o.counts).toEqual({ next: 1, returned: 1, ranges: 1, gets: 0, closes: 1 })
		})
		expect(f.calls).toEqual({ transform: 0, default: 0, coercion: 0 })
	}, 10000)
	test('actual auth query masks, default policy, composed dependencies and spread scope integrate with engine', async () => {
		const f = authenticatedFixture()
		const rows = await seed(f, 6)
		await f.t.run(async (ctx) => {
			const allowed = await ctx.db.insert('permissions', { allowed: true, tenant: 'one' })
			const denied = await ctx.db.insert('permissions', { allowed: false, tenant: 'one' })
			for (const row of rows)
				await ctx.db.patch(row._id, { permission: row.ordinal === 1 ? allowed : denied })
		})
		const authenticated = f.t.withIdentity({ subject: 'one-user', org_id: 'one', role: 'owner' })
		const args = { numItems: 100, cursor: null, filters: { status: 'open' } }
		const open = await authenticated.query(anyApi.functions.open, args)
		expect(open.page.map((row: { _id: string }) => row._id)).toEqual(
			rows.filter((row) => row.status === 'open').map((row) => row._id),
		)
		const composed = await authenticated.query(anyApi.functions.composed, args)
		expect(composed.page.map((row: { _id: string }) => row._id)).toEqual([rows[1]._id])
		expect(composed.page[0]).not.toHaveProperty('permission')
		await expect(
			authenticated.query(anyApi.functions.composed, { ...args, filters: { tenant: 'one' } }),
		).rejects.toThrow()
		await expect(authenticated.mutation(anyApi.functions.mutation, {})).rejects.toThrow(
			'UNMANAGED_QUERY_CONTEXT',
		)
	}, 10000)
	test('large registries replay across equivalent instances and reject different registries before reads', async () => {
		const first = largeRegistry(),
			equivalent = largeRegistry(),
			changed = largeRegistry(true)
		expect(first.relations.identity.length).toBeGreaterThan(16384)
		expect(equivalent.relations.identity).toBe(first.relations.identity)
		expect(changed.relations.identity).not.toBe(first.relations.identity)
		const rows = await first.t.run(async (ctx) => {
			const result = []
			for (let ordinal = 0; ordinal < 8; ordinal++) {
				const id = await ctx.db.insert('tasks', {
					ordinal,
					department: 'a',
					status: 'open',
					tenant: 'one',
					description: 'task',
					active: true,
					rank: ordinal,
					code: '',
					details: { text: 'detail', tags: [] },
					secret: 'private',
					credential: 'private',
				})
				result.push((await ctx.db.get(id))!)
			}
			return result
		})
		await first.t.run(async (ctx) => {
			const o = observed<DataModelFromSchemaDefinition<typeof first.schema>>(ctx.db)
			const q = first.querying(managed(o.raw)).tasks
			const page = await q.paginate({ numItems: 2, cursor: null })
			expect(page.page.map((row) => row._id)).toEqual(rows.slice(0, 2).map((row) => row._id))
			const replay = await equivalent
				.querying(managed(o.raw))
				.tasks.paginate({ numItems: 3, cursor: page.continueCursor })
			expect(replay.page.map((row) => row._id)).toEqual(rows.slice(2, 5).map((row) => row._id))
			const before = { ...o.counts }
			await expect(
				changed
					.querying(managed(o.raw))
					.tasks.paginate({ numItems: 3, cursor: page.continueCursor }),
			).rejects.toThrow('Invalid cursor')
			expect(o.counts).toEqual(before)
			expect(page.continueCursor.length).toBeLessThan(2048)
			expect(page.page[0]).not.toHaveProperty('secret')
			expect(page.page[0]).not.toHaveProperty('credential')
		})
	}, 10000)
	test('exact protected cursor sequence and leaf counters match independent native traversal', async () => {
		const f = harness()
		const rows = await seed(f, 24, 5)
		const filters = { department: 'a', count: 0, status: 'done' }
		const registryVersion = Array.from(
			new Uint8Array(
				await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.relations.identity)),
			),
			(byte) => byte.toString(16).padStart(2, '0'),
		).join('')
		for (const order of ['asc', 'desc'] as const) {
			const plan = createPlanner(f.schema, f.relations).plan(
				'tasks',
				{ numItems: 1, cursor: null, filters, order },
				[{ value: true, index: 'by_department_count' }],
				[],
			)
			const authority = { ...scope, policyVersion: '1' }
			const binding: CursorBinding = {
				table: 'tasks',
				index: 'by_department_count',
				order,
				clientFilters: plan.clientIdentity,
				serverFilters: { predicates: plan.serverIdentity, selection: {}, scope: authority },
				relationPath: [],
				principal: JSON.stringify(authority),
				tenant: scope.tenant,
				policyVersion: '1',
				engineVersion: 'scalar-1',
				registryVersion,
			}
			const codec = createCursorCodec(cursor)
			let token: string | null = null,
				raw: string | null = null
			const ids: string[] = []
			for (let page = 0; page < 10; page++) {
				const result = await f.t.run(async (ctx) => {
					const native = observed(ctx.db),
						actual = observed(ctx.db)
					const numItems = page % 2 ? 7 : 1
					const expected = await stream(native.raw, f.schema)
						.query('tasks')
						.withIndex('by_department_count', (q) => q.eq('department', 'a').eq('count', 0))
						.order(order)
						.filterWith(async (row) => row.status === 'done' && row.tenant === 'one')
						.paginate({ numItems, cursor: raw })
					const got = await f
						.querying(
							managed(actual.raw, { tasks: { read: async (_ctx, row) => row.tenant === 'one' } }),
						)
						.tasks.when(true, 'by_department_count')
						.paginate({ numItems, cursor: token, filters, order })
					expect(got.page.map((row) => row._id)).toEqual(expected.page.map((row) => row._id))
					expect(codec.open(got.continueCursor, binding)).toBe(expected.continueCursor)
					expect(got.isDone).toBe(expected.isDone)
					expect(actual.counts.next).toBe(native.counts.next)
					expect(actual.counts.returned).toBe(native.counts.returned)
					expect(actual.counts.ranges).toBe(native.counts.ranges)
					return { expected, got }
				})
				ids.push(...result.got.page.map((row) => row._id))
				if (result.got.isDone) break
				token = result.got.continueCursor
				raw = result.expected.continueCursor
				expect(page).toBeLessThan(9)
			}
			expect(ids).toEqual(
				sorted(
					rows.filter(
						(row) =>
							row.department === 'a' &&
							row.count === 0 &&
							row.status === 'done' &&
							row.tenant === 'one',
					),
					['department', 'count'],
					order,
				).map((row) => row._id),
			)
		}
	}, 10000)
	test('composite prefix keeps independent residual and strict ID projection', async () => {
		const f = harness()
		const rows = await seed(f)
		await f.t.run(async (ctx) => {
			const o = observed(ctx.db)
			const page = await f
				.querying(managed(o.raw))
				.tasks.when('a', 'by_department_count')
				.where({ tenant: 'one' })
				.with({})
				.paginate({ numItems: 100, cursor: null, filters: { department: 'a', status: 'open' } })
			const expected = rows
				.filter((r) => r.department === 'a' && r.status === 'open')
				.sort((a, b) =>
					compareValues(
						[a.department, a.count, a._creationTime, a._id],
						[b.department, b.count, b._creationTime, b._id],
					),
				)
			expect(page.page).toEqual(
				expected.map((r) => ({
					_id: r._id,
					ordinal: r.ordinal,
					department: r.department,
					status: r.status,
				})),
			)
			expect(page.isDone).toBe(true)
			expect(o.counts.returned).toBe(16)
			expect(o.counts.next).toBe(17)
			expect(o.counts.closes).toBe(1)
			expect(page.continueCursor).toMatch(/^pc\./)
			expect(f.tasks.toPublicDto(rows[0])).not.toHaveProperty('_id')
		})
	})
	test('exact shared boundary never looks ahead or claims exhaustion; policy errors close the actual leaf', async () => {
		const f = harness()
		const rows = await seed(f, 4)
		const querying = createQueryEngine({
			schema: f.schema,
			relations: f.relations,
			cursor,
			budgets: { rawCandidates: 4 },
		})
		const first = await f.t.run(async (ctx) => {
			const o = observed(ctx.db)
			const page = await querying(managed(o.raw)).tasks.paginate({ numItems: 100, cursor: null })
			expect(o.counts).toEqual({ next: 4, returned: 4, ranges: 1, gets: 0, closes: 1 })
			expect(page.page.map((row) => row._id)).toEqual(rows.map((row) => row._id))
			expect(page.isDone).toBe(false)
			return page
		})
		await f.t.run(async (ctx) => {
			const o = observed(ctx.db)
			const end = await querying(managed(o.raw)).tasks.paginate({
				numItems: 100,
				cursor: first.continueCursor,
			})
			expect(end.page).toEqual([])
			expect(end.isDone).toBe(true)
			expect(o.counts.returned).toBe(0)
			expect(o.counts.next).toBe(2)
			expect(o.counts.closes).toBe(2)
			const rejected = observed(ctx.db)
			await expect(
				f
					.querying(
						managed(rejected.raw, {
							tasks: {
								read: async () => {
									throw new Error('RAW_NATIVE_CURSOR_SECRET')
								},
							},
						}),
					)
					.tasks.paginate({ numItems: 1, cursor: null }),
			).rejects.toThrow('Query execution failed')
			expect(rejected.counts).toEqual({ next: 1, returned: 1, ranges: 1, gets: 0, closes: 1 })
			const small = observed(ctx.db)
			await f.querying(managed(small.raw)).tasks.paginate({ numItems: 1, cursor: null })
			expect(small.counts).toEqual({ next: 1, returned: 1, ranges: 1, gets: 0, closes: 1 })
		})
	})
	test('denied first 200 rows advance empty shared pages without fake exhaustion', async () => {
		const f = harness()
		const rows = await seed(f, 204, 200)
		const q = createQueryEngine({
			schema: f.schema,
			relations: f.relations,
			cursor,
			budgets: { rawCandidates: 100 },
		})
		let start: string | null = null
		for (let n = 0; n < 3; n++) {
			const p = await f.t.run(async (ctx) => {
				const o = observed(ctx.db)
				const p = await q(
					managed(o.raw, { tasks: { read: async (_ctx, r) => r.tenant === 'one' } }),
				).tasks.paginate({ numItems: 100, cursor: start })
				expect(o.counts.returned).toBe(n < 2 ? 100 : 4)
				expect(o.counts.next, `page ${n}: ${JSON.stringify(o.counts)}`).toBe(
					n === 0 ? 100 : n === 1 ? 101 : 6,
				)
				expect(o.counts.closes).toBe(n === 0 ? 1 : 2)
				return p
			})
			expect(p.page.map((r) => r._id)).toEqual(n < 2 ? [] : rows.slice(200).map((r) => r._id))
			expect(p.isDone).toBe(n === 2)
			expect(p.continueCursor).not.toBe(start)
			if (n < 2) expect(p.pageStatus).toBe('SplitRequired')
			start = p.continueCursor
		}
	}, 10000)
	test('split and continue are interchangeable start/end boundaries; empty end window stays native', async () => {
		const f = harness()
		await seed(f)
		await f.t.run(async (ctx) => {
			const q = f.querying(managed(ctx.db)).tasks
			const p = await q.paginate({ numItems: 10, cursor: null, maximumRowsRead: 6 })
			const left = await q.paginate({ numItems: 1, cursor: null, endCursor: p.splitCursor })
			const right = await q.paginate({
				numItems: 1,
				cursor: p.splitCursor!,
				endCursor: p.continueCursor,
			})
			expect([...left.page, ...right.page]).toEqual(p.page)
			const empty = await q.paginate({
				numItems: 1,
				cursor: p.continueCursor,
				endCursor: p.continueCursor,
			})
			expect(empty.page).toEqual([])
			expect(empty.isDone).toBe(false)
			expect(empty.continueCursor).toBe(p.continueCursor)
		})
	})
	test('incompatible condition and cursor replay reject before any read', async () => {
		const f = harness()
		await seed(f)
		await f.t.run(async (ctx) => {
			const o = observed(ctx.db)
			const q = f.querying(managed(o.raw)).tasks
			await expect(
				q.when(false, 'by_active').paginate({ numItems: 1, cursor: null }),
			).rejects.toThrow(/incompatible/)
			expect(o.counts.next).toBe(0)
			const p = await q.paginate({ numItems: 1, cursor: null, filters: { status: 'open' } })
			const before = o.counts.next
			await expect(
				q.paginate({ numItems: 7, cursor: p.continueCursor, filters: { status: 'done' } }),
			).rejects.toThrow('Invalid cursor')
			await expect(
				q.paginate({ numItems: 7, cursor: p.continueCursor + '0', filters: { status: 'open' } }),
			).rejects.toThrow('Invalid cursor')
			expect(o.counts.next).toBe(before)
		})
	})
	test('native row/byte metadata is preserved and shared bytes reserve before fetch', async () => {
		const f = harness()
		const rows = await seed(f)
		await f.t.run(async (ctx) => {
			for (const limits of [
				{ maximumRowsRead: 2 },
				{ maximumBytesRead: getDocumentSize(rows[0]) },
			]) {
				const native = await stream(ctx.db, f.schema)
					.query('tasks')
					.order('asc')
					.paginate({ numItems: 10, cursor: null, ...limits })
				const p = await f
					.querying(managed(ctx.db))
					.tasks.paginate({ numItems: 10, cursor: null, ...limits })
				expect(p.page.map((r) => r._id)).toEqual(native.page.map((r) => r._id))
				expect(p.pageStatus).toBe(native.pageStatus)
				expect(p.isDone).toBe(native.isDone)
			}
			const o = observed(ctx.db)
			const q = createQueryEngine({
				schema: f.schema,
				relations: f.relations,
				cursor,
				budgets: { documentBytes: MAX_DOCUMENT_BYTES + getDocumentSize(rows[0]) - 1 },
			})
			const p = await q(managed(o.raw)).tasks.paginate({ numItems: 10, cursor: null })
			expect(p.page).toHaveLength(1)
			expect(p.isDone).toBe(false)
			expect(o.counts.next).toBe(1)
		})
	})
	test('unknown context fails closed with relation selection supported', async () => {
		const f = harness()
		await f.t.run(async (ctx) => {
			// SAFETY: intentionally unregistered context probes runtime fail-closed behavior.
			expect(() => f.querying({ db: ctx.db as never })).toThrow(/UNMANAGED_QUERY_CONTEXT/)
			const capability = managed(ctx.db)
			expect(() => f.querying({ db: { ...capability.db } })).toThrow(/UNMANAGED_QUERY_CONTEXT/)
			await expect(
				f
					.querying(managed(ctx.db))
					.tasks.with({ referenceTask: true })
					.paginate({ numItems: 1, cursor: null }),
			).resolves.toMatchObject({ page: [], isDone: true })
		})
	})
	test('native schema ownership and live index mutations fail before reads', () => {
		const f = declarations()
		const other = declarations()
		expect(() =>
			createQueryEngine({ schema: other.schema, relations: f.relations, cursor }),
		).toThrow(/schema|ownership/i)
		const q = createQueryEngine({ schema: f.schema, relations: f.relations, cursor })
		f.tasks.table.index('late', ['status'])
		// SAFETY: mutation validation must precede even invalid context use.
		expect(() => q({ db: {} as never })).toThrow(/mutat/i)
	})
	test('unsafe/common OR, conflicting equality, ranges and absent filters match a table-array oracle', async () => {
		const f = harness()
		const rows = await seed(f)
		const cases: {
			filters?: ScalarFilters<
				(typeof f.tasks.schema)['shape'],
				ScalarSelection<(typeof f.tasks.schema)['shape']>
			>
			eligible: (r: DocumentByName<DM, 'tasks'>) => boolean
			fields: (keyof DocumentByName<DM, 'tasks'>)[]
		}[] = [
			{
				filters: undefined,
				eligible: (r: (typeof rows)[number]) => r.tenant === 'one',
				fields: [],
			},
			{
				filters: { or: [{ department: 'a' }, { status: 'done' }] },
				eligible: (r: (typeof rows)[number]) => r.department === 'a' || r.status === 'done',
				fields: [],
			},
			{
				filters: {
					or: [
						{ department: 'a', status: 'open' },
						{ department: 'a', count: 0 },
					],
				},
				eligible: (r: (typeof rows)[number]) =>
					r.department === 'a' && (r.status === 'open' || r.count === 0),
				fields: ['department'],
			},
			{
				filters: { and: [{ count: 0 }, { count: 1 }] },
				eligible: (_r: (typeof rows)[number]) => false,
				fields: ['count'],
			},
			{
				filters: { count: { gte: 1, lt: 3 }, not: { status: 'done' } },
				eligible: (r: (typeof rows)[number]) => r.count >= 1 && r.count < 3 && r.status !== 'done',
				fields: [],
			},
		]
		for (const c of cases)
			for (const order of ['asc', 'desc'] as const) {
				const output: string[] = []
				const tokens: string[] = []
				let start: string | null = null
				for (let page = 0; page < 40; page++) {
					const p = await f.t.run((ctx) =>
						f.querying(managed(ctx.db)).tasks.paginate({
							numItems: page % 2 ? 7 : 1,
							cursor: start,
							order,
							filters: c.filters,
						}),
					)
					output.push(...p.page.map((r) => r._id))
					tokens.push(p.continueCursor)
					if (p.isDone) break
					expect(p.continueCursor).not.toBe(start)
					start = p.continueCursor
					expect(page).toBeLessThan(39)
				}
				expect(output).toEqual(
					sorted(rows.filter(c.eligible), [...c.fields], order).map((r) => r._id),
				)
				expect(new Set(output).size).toBe(output.length)
				expect(tokens.every((t) => t.startsWith('pc.'))).toBe(true)
			}
	}, 10000)
	test('false, zero, empty string and nullish conditional precedence selects actual traversal', async () => {
		const f = harness()
		const rows = await seed(f)
		const gates: {
			value: FilterScalar | undefined
			index: string
			field: 'active' | 'count' | 'code'
			filter: { active?: boolean; count?: number; code?: string }
		}[] = [
			{ value: false, index: 'by_active', field: 'active', filter: { active: false, count: 1 } },
			{ value: 0, index: 'by_count', field: 'count', filter: { count: 0, code: '' } },
			{ value: '', index: 'by_code', field: 'code', filter: { code: '', count: 0 } },
		]
		for (const g of gates)
			await f.t.run(async (ctx) => {
				const q = f
					.querying(managed(ctx.db))
					.tasks.when(null, 'unknown')
					.when(undefined, 'unknown')
					.when(g.value, g.index)
					.when(true, 'unknown')
				const p = await q.paginate({ numItems: 100, cursor: null, filters: g.filter })
				// SAFETY: gates enumerate supported native keys only.
				const expected = rows.filter((r) =>
					Object.entries(g.filter).every(([key, value]) => r[key as keyof typeof r] === value),
				)
				expect(p.page.map((r) => r._id)).toEqual(
					sorted(expected, [g.field], 'asc').map((r) => r._id),
				)
				// The gate value is deliberately unrelated to the binding value.
				const gate = await f
					.querying(managed(ctx.db))
					.tasks.when(999, g.index)
					.paginate({ numItems: 100, cursor: null, filters: g.filter })
				expect(gate).toEqual(p)
			})
	})
	test('native bigint/ID values, missing vs null, existence and no scalar coercion', async () => {
		const f = harness()
		const rows = await seed(f)
		await f.t.run(async (ctx) => {
			const q = f.querying(managed(ctx.db)).tasks
			for (const [filters, expected] of [
				[{ big: { gte: 3n, lt: 6n } }, rows.filter((r) => r.big >= 3n && r.big < 6n)],
				[{ optional: null }, rows.filter((r) => r.optional === null)],
				[{ optional: { exists: false } }, rows.filter((r) => !Object.hasOwn(r, 'optional'))],
				[{ optional: { exists: true } }, rows.filter((r) => Object.hasOwn(r, 'optional'))],
				[{ optional: '' }, rows.filter((r) => r.optional === '')],
				[{ _id: rows[7]._id }, [rows[7]]],
				[{ reference: null }, rows],
				// Native compareValues distinguishes IEEE negative zero from positive zero.
				[{ count: -0 }, []],
			] as const) {
				const p = await q.paginate({ numItems: 100, cursor: null, filters })
				expect(p.page.map((r) => r._id)).toEqual(expected.map((r) => r._id))
			}
			// SAFETY: deliberately bypass the static scalar type to assert runtime validation.
			await expect(
				q.paginate({ numItems: 1, cursor: null, filters: { big: '3' } as never }),
			).rejects.toThrow()
		})
	})
	test('artificial public clock ties: eight complete engine sequences, restored finally', async () => {
		const f = harness()
		const original = Date.now
		Date.now = () => 2 ** 44
		let rows: Awaited<ReturnType<typeof seed>>
		try {
			rows = await seed(f)
		} finally {
			Date.now = original
		}
		expect(new Set(rows.map((r) => r._creationTime)).size).toBe(1)
		for (const mode of ['creation', 'department'] as const)
			for (const order of ['asc', 'desc'] as const)
				for (const size of [1, 7]) {
					const filters = mode === 'department' ? { department: 'a' } : undefined
					const expected = sorted(
						rows.filter((r) => mode === 'creation' || r.department === 'a'),
						[],
						order,
					).map((r) => r._id)
					const actual: string[] = []
					let start: string | null = null
					for (let page = 0; page < 30; page++) {
						const p = await f.t.run((ctx) =>
							f
								.querying(managed(ctx.db))
								.tasks.paginate({ numItems: size, cursor: start, order, filters }),
						)
						actual.push(...p.page.map((r) => r._id))
						if (p.isDone) break
						expect(p.continueCursor).not.toBe(start)
						start = p.continueCursor
						expect(page).toBeLessThan(29)
					}
					expect(actual).toEqual(expected)
				}
	}, 10000)
	test('policy reads share budget; unresolved second candidate fails instead of skipping it; missing gets cost calls', async () => {
		const f = harness()
		const rows = await seed(f, 4)
		const ids = await f.t.run(async (ctx) => {
			const allowed = await ctx.db.insert('permissions', { allowed: true, tenant: 'one' })
			const missing = await ctx.db.insert('permissions', { allowed: true, tenant: 'one' })
			await ctx.db.delete(missing)
			for (const row of rows)
				await ctx.db.patch(row._id, { permission: row.ordinal === 2 ? missing : allowed })
			return { allowed, missing }
		})
		await f.t.run(async (ctx) => {
			const o = observed(ctx.db)
			const q = createQueryEngine({
				schema: f.schema,
				relations: f.relations,
				cursor,
				budgets: { readOperations: 3 },
			})
			// First parent + cached authorized dependency + second parent completes exactly.
			const p = await q(
				managed(o.raw, {
					tasks: { read: async ({ db }, r) => !!(await db.get('permissions', r.permission!)) },
				}),
			).tasks.paginate({ numItems: 100, cursor: null })
			expect(p.page.map((r) => r._id)).toEqual(rows.slice(0, 2).map((r) => r._id))
			expect(p.isDone).toBe(false)
			expect(o.counts).toEqual({ next: 2, returned: 2, ranges: 1, gets: 1, closes: 1 })
			const o2 = observed(ctx.db)
			const incomplete = createQueryEngine({
				schema: f.schema,
				relations: f.relations,
				cursor,
				budgets: { readOperations: 2 },
			})
			await expect(
				incomplete(
					managed(o2.raw, {
						tasks: {
							read: async ({ db }, r) => {
								await db.get('permissions', ids.allowed)
								await db.get('permissions', ids.missing)
								return r.tenant === 'one'
							},
						},
					}),
				).tasks.paginate({ numItems: 100, cursor: null }),
			).rejects.toThrow('MANAGED_READ_BUDGET')
			expect(o2.counts).toEqual({ next: 1, returned: 1, ranges: 1, gets: 1, closes: 1 })
			const o3 = observed(ctx.db)
			const all = await f
				.querying(
					managed(o3.raw, {
						tasks: { read: async ({ db }, r) => !!(await db.get('permissions', r.permission!)) },
					}),
				)
				.tasks.paginate({ numItems: 100, cursor: null })
			expect(all.page.map((r) => r._id)).toEqual(
				rows.filter((r) => r.ordinal !== 2).map((r) => r._id),
			)
			expect(o3.counts.gets).toBe(2)
			expect(o3.counts.next).toBe(5)
		})
	})
	test('replays across scope/order/index/table/version reject before native reads; page size alone resumes', async () => {
		const f = harness()
		const rows = await seed(f)
		await f.t.run(async (ctx) => {
			const first = await f
				.querying(managed(ctx.db))
				.tasks.paginate({ numItems: 1, cursor: null, filters: { department: 'a' } })
			const o = observed(ctx.db)
			const q = f.querying(managed(o.raw)).tasks
			const next = await q.paginate({
				numItems: 7,
				cursor: first.continueCursor,
				filters: { department: 'a' },
			})
			expect(next.page.map((r) => r._id)).toEqual(
				rows
					.filter((r) => r.department === 'a')
					.slice(1, 8)
					.map((r) => r._id),
			)
			const before = o.counts.next
			for (const run of [
				() =>
					q.paginate({
						numItems: 1,
						cursor: first.continueCursor,
						order: 'desc',
						filters: { department: 'a' },
					}),
				() =>
					q
						.when(true, 'by_department_count')
						.paginate({ numItems: 1, cursor: first.continueCursor, filters: { department: 'a' } }),
				() =>
					q
						.where({ tenant: 'one' })
						.paginate({ numItems: 1, cursor: first.continueCursor, filters: { department: 'a' } }),
				() =>
					f.querying(managed(o.raw, {}, 'allow', { ...scope, principal: 'other' })).tasks.paginate({
						numItems: 1,
						cursor: first.continueCursor,
						filters: { department: 'a' },
					}),
				() =>
					f.querying(managed(o.raw, {}, 'allow', { ...scope, role: 'other' })).tasks.paginate({
						numItems: 1,
						cursor: first.continueCursor,
						filters: { department: 'a' },
					}),
				() =>
					f
						.querying(managed(o.raw))
						.permissions.paginate({ numItems: 1, cursor: first.continueCursor }),
				() =>
					createQueryEngine({
						schema: f.schema,
						relations: f.relations,
						cursor,
						engineVersion: '2',
					})(managed(o.raw)).tasks.paginate({
						numItems: 1,
						cursor: first.continueCursor,
						filters: { department: 'a' },
					}),
				() =>
					createQueryEngine({
						schema: f.schema,
						relations: f.relations,
						cursor,
						policyVersion: '2',
					})(managed(o.raw)).tasks.paginate({
						numItems: 1,
						cursor: first.continueCursor,
						filters: { department: 'a' },
					}),
			])
				await expect(run()).rejects.toThrow('Invalid cursor')
			expect(o.counts.next).toBe(before)
		})
	})
	test('native concurrent insertion/deletion semantics are retained in both traversal orders', async () => {
		for (const order of ['asc', 'desc'] as const) {
			const f = harness()
			const rows = await seed(f, 6)
			const first = await f.t.run((ctx) =>
				f.querying(managed(ctx.db)).tasks.paginate({ numItems: 2, cursor: null, order }),
			)
			const nativeFirst = await f.t.run((ctx) =>
				stream(ctx.db, f.schema)
					.query('tasks')
					.order(order)
					.paginate({ numItems: 2, cursor: null }),
			)
			await f.t.run(async (ctx) => {
				await ctx.db.delete(rows[3]._id)
				await ctx.db.insert('tasks', {
					ordinal: 99,
					department: 'a',
					status: 'open',
					active: true,
					count: 0,
					code: '',
					big: 99n,
					reference: null,
					tenant: 'one',
					secret: 'private',
				})
			})
			const later = await f.t.run((ctx) =>
				f
					.querying(managed(ctx.db))
					.tasks.paginate({ numItems: 100, cursor: first.continueCursor, order }),
			)
			const nativeLater = await f.t.run((ctx) =>
				stream(ctx.db, f.schema)
					.query('tasks')
					.order(order)
					.paginate({ numItems: 100, cursor: nativeFirst.continueCursor }),
			)
			expect(later.page.map((r) => r._id)).toEqual(nativeLater.page.map((r) => r._id))
			expect(later.isDone).toBe(nativeLater.isDone)
			expect(later.page.some((r) => r.ordinal === 99)).toBe(order === 'asc')
		}
	})
	test('live DTO and stored validator mutation is guarded after a cached plan and before projection', async () => {
		const f = harness()
		await seed(f, 1)
		await f.t.run(async (ctx) => {
			const q = f.querying(managed(ctx.db)).tasks
			await q.paginate({ numItems: 1, cursor: null })
			Reflect.set(f.tasks.schema.shape, 'count', f.tasks.schema.shape.code)
			await expect(q.paginate({ numItems: 1, cursor: null })).rejects.toThrow(/mutat/)
		})
		const f2 = harness()
		await seed(f2, 1)
		await f2.t.run(async (ctx) => {
			const o = observed(ctx.db)
			const q = f2.querying(
				managed(o.raw, {
					tasks: {
						read: async () => {
							Reflect.set(f2.tasks.publicDto.shape.ordinal._zod, 'def', { type: 'string' })
							return true
						},
					},
				}),
			).tasks
			await expect(q.paginate({ numItems: 1, cursor: null })).rejects.toThrow(
				'Query execution failed',
			)
			expect(o.counts.closes).toBe(1)
		})
		const f3 = harness()
		await seed(f3, 1)
		await f3.t.run(async (ctx) => {
			const o = observed(ctx.db)
			const q = f3.querying(
				managed(o.raw, {
					tasks: {
						read: async () => {
							Reflect.set(f3.schema.tables, 'tasks', declarations().tasks.table)
							return true
						},
					},
				}),
			).tasks
			await expect(q.paginate({ numItems: 1, cursor: null })).rejects.toThrow(
				'Query execution failed',
			)
			expect(o.counts.closes).toBe(1)
		})
	})
})
