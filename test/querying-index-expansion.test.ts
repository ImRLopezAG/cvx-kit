import { expect, test } from 'vite-plus/test'
import { compareValues } from 'convex/values'
import { createQueryEngine } from '../src/querying'
import { MAX_DOCUMENT_BYTES, ManagedReadError } from '../src/querying/security'
import { harness, seed, managed, observed, cursor } from './fixture-querying/scalar'

test('U4 actual helper full index versus tail, normalized continuation and native intervals', async () => {
	const f = harness()
	const original = Date.now
	Date.now = () => 2 ** 44
	const rows = await seed(f, 60).finally(() => {
		Date.now = original
	})
	await f.t.run(async (ctx) => {
		const o = observed(ctx.db)
		const q = f.querying(
			managed(o.raw, { tasks: { read: async (_, row) => row.ordinal % 7 !== 0 } }),
		).tasks
		for (const order of ['asc', 'desc'] as const)
			for (const explicit of [false, true]) {
				const query = explicit ? q.orderBy('by_department_count') : q
				const filters = { department: { in: ['b', 'a', 'b'] }, count: { gte: 1, lt: 3 } }
				const expected = rows
					.filter((r) => r.count >= 1 && r.count < 3 && r.ordinal % 7 !== 0)
					.sort((a, b) => {
						const fields: ('department' | 'count' | '_creationTime' | '_id')[] = explicit
							? ['department', 'count', '_creationTime', '_id']
							: ['count', '_creationTime', '_id']
						for (const field of fields) {
							const compared = compareValues(a[field], b[field])
							if (compared) return compared * (order === 'asc' ? 1 : -1)
						}
						return 0
					})
					.map((r) => r._id)
				const first = await query.paginate({ numItems: 3, cursor: null, order, filters })
				const got = first.page.map((r) => r._id)
				let next = first
				for (let i = 0; !next.isDone && i < 40; i++) {
					next = await query.paginate({
						numItems: 4,
						cursor: next.continueCursor,
						order,
						filters: { ...filters, department: { in: ['a', 'b'] } },
					})
					got.push(...next.page.map((r) => r._id))
				}
				expect(next.isDone).toBe(true)
				expect(got).toEqual(expected)
				expect(new Set(got).size).toBe(got.length)
				await expect(
					query.paginate({
						numItems: 3,
						cursor: first.continueCursor,
						order,
						filters: { ...filters, department: { in: ['a', 'c'] } },
					}),
				).rejects.toThrow('Invalid cursor')
				const interval = await query.paginate({
					numItems: 1,
					cursor: null,
					endCursor: first.continueCursor,
					order,
					filters,
				})
				expect(interval.page).toEqual(first.page)
			}
		expect(o.counts.closes).toBe(o.counts.ranges)
		expect(
			(await q.paginate({ numItems: 2, cursor: null, filters: { department: { in: [] } } })).page,
		).toEqual([])
	})
})
test('U4 2..8 leaves meter prefetch and close on tiny row/byte failures', async () => {
	const f = harness()
	await seed(f, 48)
	await f.t.run(async (ctx) => {
		for (let size = 2; size <= 8; size++) {
			const values = ['a', 'b', ...Array.from({ length: size - 2 }, (_, i) => `missing${i}`)]
			const o = observed(ctx.db)
			const result = await f
				.querying(managed(o.raw))
				.tasks.orderBy('by_department_count')
				.paginate({ numItems: 1, cursor: null, filters: { department: { in: values } } })
			expect(result.page).toHaveLength(1)
			expect(o.counts.ranges).toBe(size)
			expect(o.counts.closes).toBe(size)
			expect(o.counts.returned).toBe(2)
		}
		for (const budgets of [{ readOperations: 1 }, { documentBytes: MAX_DOCUMENT_BYTES }]) {
			const o = observed(ctx.db)
			const engine = createQueryEngine({
				schema: f.schema,
				relations: f.relations,
				cursor,
				budgets,
			})
			await expect(
				engine(managed(o.raw)).tasks.paginate({
					numItems: 2,
					cursor: null,
					filters: { department: { in: ['a', 'b'] } },
				}),
			).rejects.toThrow('MANAGED_READ_BUDGET')
			expect(o.counts.closes).toBe(o.counts.ranges)
		}
	})
})

test('U4 actual OR normalization, fanout branches and split replacement', async () => {
	const f = harness()
	await seed(f, 80)
	await f.t.run(async (ctx) => {
		const o = observed(ctx.db)
		const q = f.querying(managed(o.raw)).tasks
		const filters = { or: [{ department: 'b' }, { department: 'a' }, { department: 'a' }] }
		const first = await q.paginate({ numItems: 20, cursor: null, maximumRowsRead: 4, filters })
		expect(first.pageStatus).toBe('SplitRequired')
		expect(first.splitCursor).toBeTruthy()
		const left = await q.paginate({
			numItems: 100,
			cursor: null,
			endCursor: first.splitCursor,
			filters,
		})
		const right = await q.paginate({
			numItems: 100,
			cursor: first.splitCursor!,
			endCursor: first.continueCursor,
			filters: { or: [{ department: 'a' }, { department: 'b' }] },
		})
		expect([...left.page, ...right.page]).toEqual(first.page)
		const nine = { department: { in: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] } }
		const before = { ...o.counts }
		await expect(q.paginate({ numItems: 1, cursor: null, filters: nine })).rejects.toThrow(
			'QUERY_FANOUT',
		)
		expect(o.counts).toEqual(before)
		const explicit = await q
			.orderBy('by_department')
			.paginate({ numItems: 100, cursor: null, filters: nine })
		expect(explicit.page).toHaveLength(80)
		expect(explicit.page.slice(0, 53).every((r) => r.department === 'a')).toBe(true)
	})
})

test('U4 metered pages resume completed candidates and never partialize mid-policy errors', async () => {
	const f = harness()
	const rows = await seed(f, 40)
	const engine = createQueryEngine({
		schema: f.schema,
		relations: f.relations,
		cursor,
		budgets: { readOperations: 4 },
	})
	await f.t.run(async (ctx) => {
		const o = observed(ctx.db)
		const filters = { department: { in: ['a', 'b'] } }
		const ids: string[] = []
		let token: string | null = null
		for (let i = 0; i < 40; i++) {
			const page = await engine(managed(o.raw)).tasks.paginate({
				numItems: 100,
				cursor: token,
				filters,
			})
			ids.push(...page.page.map((row) => row._id))
			if (page.isDone) break
			expect(page.continueCursor).not.toBe(token)
			token = page.continueCursor
		}
		expect(ids).toEqual(
			rows
				.slice()
				.sort(
					(a, b) => compareValues(a._creationTime, b._creationTime) || compareValues(a._id, b._id),
				)
				.map((row) => row._id),
		)
		expect(o.counts.closes).toBe(o.counts.ranges)
		let policies = 0
		const broken = managed(ctx.db, {
			tasks: {
				read: async () => {
					if (++policies === 2) throw new ManagedReadError('MANAGED_READ_BUDGET')
					return true
				},
			},
		})
		await expect(
			f.querying(broken).tasks.paginate({ numItems: 20, cursor: null, filters }),
		).rejects.toThrow('MANAGED_READ_BUDGET')
		expect(policies).toBe(2)
	})
})

test('U4 registered auth query retains tenancy, policy and strict public DTOs for sets', async () => {
	const { authenticatedFixture } = await import('./fixture-querying/auth')
	const { anyApi } = await import('convex/server')
	const f = authenticatedFixture()
	const rows = await seed(f, 30, 10)
	await f.t.run(async (ctx) => {
		const permission = await ctx.db.insert('permissions', { allowed: true, tenant: 'one' })
		for (const row of rows.filter((row) => row.ordinal % 3 === 0))
			await ctx.db.patch(row._id, { permission })
	})
	const client = f.t.withIdentity({ subject: 'user', org_id: 'one', role: 'owner' })
	const first = await client.query(anyApi.functions.composed, {
		numItems: 2,
		cursor: null,
		filters: { status: { in: ['open', 'done', 'open'] } },
	})
	const rest = await client.query(anyApi.functions.composed, {
		numItems: 100,
		cursor: first.continueCursor,
		filters: { status: { in: ['done', 'open'] } },
	})
	expect([...first.page, ...rest.page].map((row) => row.ordinal)).toEqual(
		rows.filter((row) => row.tenant === 'one' && row.ordinal % 3 === 0).map((row) => row.ordinal),
	)
	expect(
		[...first.page, ...rest.page].every(
			(row) => !Object.hasOwn(row, 'secret') && !Object.hasOwn(row, 'permission'),
		),
	).toBe(true)
})
