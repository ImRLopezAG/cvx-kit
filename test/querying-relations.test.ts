import { expect, test, vi } from 'vite-plus/test'
import { relationshipFixture, seedRelationships } from './fixture-querying/relationships'
import { createQueryEngine } from '../src/querying'
import { cursor, managed, scope } from './fixture-querying/scalar'
import { ManagedReadError, MAX_DOCUMENT_BYTES } from '../src/querying/security'
import { ConvexError, getDocumentSize, type Value } from 'convex/values'
import { anyApi } from 'convex/server'
import { relationshipAuthFixture } from './fixture-querying/relationships-auth'

test('owned root, direct and flattened streams ignore later source index and table replacements', async () => {
	const f = relationshipFixture()
	await seedRelationships(f)
	await f.t.run(async (ctx) => {
		const query = f.querying(f.context(ctx.db).ctx).tasks.with({ direct: true, codeLabels: true })
		const args = { numItems: 2, cursor: null, filters: { code: 'shared' } }
		const first = await query.paginate(args)
		const indexes = Object.getOwnPropertyDescriptor(f.labels.table, 'indexes')!.value
		for (const index of indexes) index.fields.reverse()
		f.tasks.table.index('added_later', ['ordinal'])
		Reflect.set(f.schema.tables, 'tasks', relationshipFixture().tasks.table)
		Reflect.set(f.labels.schema.shape, 'code', f.labels.schema.shape.ordinal)
		expect(await query.paginate(args)).toEqual(first)
	})
})

test('U6 one/self/named/direct/junction output is authorized and preserves edge multiplicity', async () => {
	const f = relationshipFixture()
	const rows = await seedRelationships(f)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const result = await f
			.querying(o.ctx)
			.tasks.with({
				referenceTask: true,
				requiredLabel: true,
				byCode: true,
				direct: true,
				labels: true,
				aliasLabels: true,
			})
			.paginate({ numItems: 100, cursor: null })
		expect(result.page.map((r) => r._id)).toEqual(rows.tasks.slice(1).map((r) => r._id))
		expect(result.page[0].referenceTask?._id).toBe(rows.tasks[2]._id)
		expect(result.page[1].referenceTask).toBeNull()
		expect(result.page[2].referenceTask).toBeNull()
		expect(result.page[0].byCode?._id).toBe(rows.labels[1]._id)
		expect(result.page[0].direct.page.map((r) => r._id)).toEqual(
			rows.labels.filter((r) => r.allowed && r.tenant === 'one').map((r) => r._id),
		)
		const expected = rows.edges
			.filter((e) => e.task === rows.tasks[1]._id && e.allowed)
			.flatMap((e) =>
				rows.labels
					.filter((l) => l._id === e.label && l.allowed && l.tenant === 'one')
					.map((l) => l._id),
			)
		expect(result.page[0].labels.page.map((r) => r._id)).toEqual(expected)
		expect(result.page[0].aliasLabels.page.map((r) => r._id)).toEqual(expected)
		expect(
			f.relations.tables.tasks
				.pageDto({
					referenceTask: true,
					requiredLabel: true,
					byCode: true,
					direct: true,
					labels: true,
					aliasLabels: true,
				})
				.parse(result),
		).toEqual(result)
	})
})

test('U6 some/none eligibility proves late authorized matches before page fill', async () => {
	const f = relationshipFixture()
	const rows = await seedRelationships(f)
	await f.t.run(async (ctx) => {
		const q = f.querying(f.context(ctx.db).ctx).tasks
		const some = await q.paginate({
			numItems: 100,
			cursor: null,
			filters: { labels: { some: { ordinal: 1 } } },
		})
		expect(some.page.map((r) => r._id)).toEqual(rows.tasks.slice(1, 4).map((r) => r._id))
		const none = await q.paginate({
			numItems: 100,
			cursor: null,
			filters: { labels: { none: {} } },
		})
		expect(none.page.map((r) => r._id)).toEqual(rows.tasks.slice(4).map((r) => r._id))
		const absent = await q.paginate({
			numItems: 100,
			cursor: null,
			filters: { referenceTask: null },
		})
		expect(absent.page.map((r) => r._id)).toEqual(rows.tasks.slice(2).map((r) => r._id))
	})
})

test('U6 protected direct/junction continuations retain full ordered duplicate sequences across page sizes', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	for (const name of ['labels', 'direct'] as const)
		for (const order of ['asc', 'desc'] as const)
			for (const size of [1, 2, 7]) {
				const expected =
					name === 'direct'
						? rows.labels.filter((l) => l.allowed && l.tenant === 'one').map((l) => l._id)
						: rows.edges
								.filter((e) => e.task === rows.tasks[1]._id && e.allowed)
								.flatMap((e) =>
									rows.labels
										.filter((l) => l._id === e.label && l.allowed && l.tenant === 'one')
										.map((l) => l._id),
								)
				if (order === 'desc') expected.reverse()
				let cursor: string | null = null
				const actual: string[] = []
				for (let page = 0; page < 30; page++) {
					const result = await f.t.run((ctx) =>
						f
							.querying(f.context(ctx.db).ctx)
							.tasks.relation(rows.tasks[1]._id, name)
							.paginate({ numItems: page % 2 ? size + 1 : size, cursor, order }),
					)
					actual.push(...result.page.map((r) => r._id))
					expect(result.continueCursor).toMatch(/^pc\./)
					if (result.isDone) break
					expect(result.continueCursor).not.toBe(cursor)
					cursor = result.continueCursor
					expect(page).toBeLessThan(29)
				}
				expect(actual).toEqual(expected)
			}
})

test('U6 nested continuation binds original parent/path and reauthorizes ancestors', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	const first = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.tasks.with({ labels: { owner: { labels: true } } })
			.paginate({ numItems: 1, cursor: null, filters: { _id: rows.tasks[1]._id } }),
	)
	const nested = first.page[0].labels.page[0].owner!.labels
	const continued = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.tasks.relation(rows.tasks[1]._id, 'labels.owner.labels')
			.paginate({ numItems: 100, cursor: nested.continueCursor }),
	)
	expect([...nested.page, ...continued.page].map((r) => r._id)).toEqual([
		rows.labels[1]._id,
		rows.labels[1]._id,
		rows.labels[4]._id,
		rows.labels[5]._id,
	])
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db),
			q = f.querying(o.ctx).tasks
		for (const [parent, path] of [
			[rows.tasks[2]._id, 'labels.owner.labels'],
			[rows.tasks[1]._id, 'aliasLabels.owner.labels'],
		] as const) {
			await expect(
				q.relation(parent, path).paginate({ numItems: 1, cursor: nested.continueCursor }),
			).rejects.toThrow('Invalid cursor')
		}
		expect(o.counts.gets).toBe(0)
		expect(o.counts.next).toBe(0)
	})
	await f.t.run((ctx) => ctx.db.patch(rows.tasks[1]._id, { allowed: false }))
	const revoked = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.tasks.relation(rows.tasks[1]._id, 'labels.owner.labels')
			.paginate({ numItems: 100, cursor: nested.continueCursor }),
	)
	expect(revoked.page).toEqual([])
})

test('U6 authorized indexed one ambiguity ignores hidden matches and stops at two authorized rows', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	await f.t.run(async (ctx) => {
		const q = f.querying(f.context(ctx.db).ctx).tasks.with({ byCode: true })
		const hidden = await q.paginate({
			numItems: 1,
			cursor: null,
			filters: { _id: rows.tasks[1]._id },
		})
		expect(hidden.page[0].byCode?._id).toBe(rows.labels[1]._id)
	})
	await f.t.run(async (ctx) => {
		await ctx.db.patch(rows.labels[4]._id, { code: 'shared' })
		await ctx.db.patch(rows.labels[5]._id, { code: 'shared' })
	})
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		await expect(
			f
				.querying(o.ctx)
				.tasks.with({ byCode: true })
				.paginate({ numItems: 1, cursor: null, filters: { _id: rows.tasks[1]._id } }),
		).rejects.toMatchObject({ code: 'AMBIGUOUS_RELATION' })
		expect(o.counts.gets).toBe(0)
		expect(o.counts.returned).toBe(5) // denied root + selected root + hidden target + exactly two authorized targets.
		expect(o.counts.next).toBe(5) // two root candidates plus the bounded three-row lookup probe.
		expect(o.counts.closes).toBe(o.counts.ranges)
	})
})

test('U6 missing/hidden references, empty targets, denied junctions and denied parents are indistinguishable', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	await f.t.run(async (ctx) => {
		await ctx.db.delete(rows.labels[1]._id)
		await ctx.db.patch(rows.tasks[4]._id, {
			required: rows.labels[0]._id,
			reference: rows.tasks[0]._id,
		})
		await ctx.db.delete(rows.tasks[2]._id)
	})
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const q = f
			.querying(o.ctx)
			.tasks.with({ referenceTask: true, requiredLabel: true, labels: true })
		const result = await q.paginate({ numItems: 100, cursor: null })
		for (const row of result.page) {
			expect(row.referenceTask).toBeNull()
			expect(row.requiredLabel).toBeNull()
		}
		expect(result.page[0].labels.page.map((l) => l._id)).toEqual([
			rows.labels[4]._id,
			rows.labels[5]._id,
		])
		expect(result.page.find((r) => r._id === rows.tasks[4]._id)!.labels.page).toEqual([])
		const hidden = await f
			.querying(o.ctx)
			.tasks.relation(rows.tasks[0]._id, 'labels')
			.paginate({ numItems: 100, cursor: null })
		const missing = await f
			.querying(o.ctx)
			.tasks.relation(rows.tasks[2]._id, 'labels')
			.paginate({ numItems: 100, cursor: null })
		expect(hidden.page).toEqual(missing.page)
		expect(hidden.isDone).toBe(missing.isDone)
	})
})

test('U6 request memo caches authorized/missing/denied targets across parents without deduplicating rows', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const page = await f
			.querying(o.ctx)
			.tasks.with({ requiredLabel: true, labels: true, aliasLabels: true })
			.paginate({ numItems: 100, cursor: null })
		expect(page.page.slice(0, 3).map((r) => r.labels.page.map((l) => l._id))).toEqual(
			Array.from({ length: 3 }, () => [
				rows.labels[1]._id,
				rows.labels[1]._id,
				rows.labels[4]._id,
				rows.labels[5]._id,
			]),
		)
		expect(o.counts.gets).toBe(5) // two denied and three visible targets, each fetched once.
		expect(o.counts.next).toBe(59) // root 7 + six (7 edges + terminal) + four empty ranges.
		expect(o.counts.closes).toBe(o.counts.ranges)
	})
})

test('U6 relation split/end/terminal tokens reject scope/filter/output/path tampering before reads', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db),
			q = f.querying(o.ctx).tasks.relation(rows.tasks[1]._id, 'labels')
		const p = await q.paginate({ numItems: 100, cursor: null, maximumRowsRead: 5 })
		expect(p.splitCursor).toMatch(/^pc\./)
		const left = await q.paginate({ numItems: 100, cursor: null, endCursor: p.splitCursor })
		const right = await q.paginate({
			numItems: 100,
			cursor: p.splitCursor!,
			endCursor: p.continueCursor,
		})
		expect([...left.page, ...right.page]).toEqual(p.page)
		const empty = await q.paginate({
			numItems: 100,
			cursor: p.continueCursor,
			endCursor: p.continueCursor,
		})
		expect(empty.page).toEqual([])
		const terminal = await q.paginate({ numItems: 100, cursor: p.continueCursor })
		const before = { ...o.counts }
		for (const token of [p.continueCursor, p.splitCursor!, terminal.continueCursor]) {
			for (const run of [
				() => q.paginate({ numItems: 1, cursor: token + '00' }),
				() => q.paginate({ numItems: 1, cursor: token, order: 'desc' }),
				() => q.paginate({ numItems: 1, cursor: token, filters: { ordinal: 1 } }),
				() => q.where({ allowed: true }).paginate({ numItems: 1, cursor: token }),
				() => q.with({ owner: true }).paginate({ numItems: 1, cursor: token }),
				() =>
					f
						.querying(managed(o.raw, {}, 'allow', { ...scope, tenant: 'two' }))
						.tasks.relation(rows.tasks[1]._id, 'labels')
						.paginate({ numItems: 1, cursor: token }),
			])
				await expect(run()).rejects.toThrow('Invalid cursor')
		}
		expect(o.counts).toEqual(before)
		// SAFETY: deliberately erase a foreign table brand to exercise runtime ID rejection.
		await expect(
			f
				.querying(o.ctx)
				.tasks.relation(rows.labels[1]._id as never, 'labels')
				.paginate({ numItems: 1, cursor: null }),
		).rejects.toThrow('INVALID_RELATION')
		expect(o.counts).toEqual(before)
	})
})

test('U6 incomplete none, output and ambiguity work throws typed shared budget errors', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	for (const budgets of [
		{ readOperations: 2 },
		{ rawCandidates: 2 },
		{ indexRanges: 1 },
		{ fanout: 1 },
		{ documentBytes: MAX_DOCUMENT_BYTES + getDocumentSize(rows.tasks[1]) },
		{ memoEntries: 1 },
	]) {
		await f.t.run(async (ctx) => {
			const o = f.context(ctx.db)
			const querying = createQueryEngine({
				schema: f.schema,
				relations: f.relations,
				cursor,
				budgets,
			})
			await expect(
				querying(o.ctx).tasks.paginate({
					numItems: 1,
					cursor: null,
					filters: { _id: rows.tasks[1]._id, labels: { none: { ordinal: 99 } } },
				}),
			).rejects.toBeInstanceOf(ManagedReadError)
			expect(o.counts.closes).toBe(o.counts.ranges)
			if ('readOperations' in budgets) expect(o.counts.next + o.counts.gets).toBe(2)
			if ('indexRanges' in budgets) expect(o.counts.ranges).toBe(1)
		})
	}
	await f.t.run(async (ctx) => {
		for (const selection of [{ labels: true }, { byCode: true }] as const) {
			const o = f.context(ctx.db)
			const querying = createQueryEngine({
				schema: f.schema,
				relations: f.relations,
				cursor,
				budgets: { readOperations: 3 },
			})
			await expect(
				querying(o.ctx)
					.tasks.with(selection)
					.paginate({ numItems: 1, cursor: null, filters: { _id: rows.tasks[1]._id } }),
			).rejects.toMatchObject({ code: 'MANAGED_READ_BUDGET' })
			expect(o.counts.next + o.counts.gets).toBe(3)
		}
	})
})

test('U6 indexed junction target output uses native concatenated keys across full resumed sequences', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	await f.t.run((ctx) => ctx.db.patch(rows.labels[4]._id, { code: 'shared' }))
	const labels = rows.labels.map((l) => (l.ordinal === 4 ? { ...l, code: 'shared' } : l))
	for (const order of ['asc', 'desc'] as const)
		for (const size of [1, 2, 7]) {
			const junctions = rows.edges.filter((e) => e.task === rows.tasks[1]._id && e.allowed)
			if (order === 'desc') junctions.reverse()
			const expected = junctions.flatMap((e) => {
				const matches = labels.filter(
					(l) => l.allowed && l.tenant === 'one' && l.code === e.labelCode,
				)
				if (order === 'desc') matches.reverse()
				return matches.map((l) => l._id)
			})
			let token: string | null = null
			const actual: string[] = []
			for (let page = 0; page < 50; page++) {
				const p = await f.t.run((ctx) =>
					f
						.querying(f.context(ctx.db).ctx)
						.tasks.relation(rows.tasks[1]._id, 'codeLabels')
						.paginate({ numItems: size, cursor: token, order }),
				)
				actual.push(...p.page.map((l) => l._id))
				if (p.isDone) break
				expect(p.continueCursor).not.toBe(token)
				token = p.continueCursor
				expect(page).toBeLessThan(49)
			}
			expect(actual).toEqual(expected)
		}
})

test('U6 cyclic references and policy recursion terminate under shared depth without pending memo hangs', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	await f.t.run((ctx) => ctx.db.patch(rows.tasks[1]._id, { reference: rows.tasks[1]._id }))
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const querying = createQueryEngine({
			schema: f.schema,
			relations: f.relations,
			cursor,
			budgets: { depth: 2 },
		})
		await expect(
			querying(o.ctx)
				.tasks.with({ referenceTask: { referenceTask: { referenceTask: true } } })
				.paginate({ numItems: 1, cursor: null, filters: { _id: rows.tasks[1]._id } }),
		).rejects.toMatchObject({ code: 'MANAGED_READ_BUDGET' })
		expect(o.counts.gets).toBe(1)
		const recursive = managed(o.raw, {
			tasks: { read: async ({ db }, d) => !!(await db.get('tasks', d._id)) },
		})
		await expect(
			f.querying(recursive).tasks.paginate({ numItems: 1, cursor: null }),
		).rejects.toMatchObject({ code: 'POLICY_RECURSION' })
	})
})

test('U6 registered auth queries validate branded nested DTO pages and reauthorize relation continuation', async () => {
	const f = relationshipAuthFixture(),
		rows = await seedRelationships(f)
	const client = f.t.withIdentity({ subject: 'one-user', org_id: 'one', role: 'owner' })
	const first = await client.query(anyApi.functions.page, {
		numItems: 1,
		cursor: null,
		filters: { ordinal: 1, labels: { some: { ordinal: 1 } } },
	})
	expect(first.page[0]._id).toBe(rows.tasks[1]._id)
	expect(first.page[0].labels.page[0]._id).toBe(rows.labels[1]._id)
	expect(first.page[0].labels.page[0].owner._id).toBe(rows.tasks[1]._id)
	const token = first.page[0].labels.continueCursor
	const next = await client.query(anyApi.functions.next, {
		parent: rows.tasks[1]._id,
		numItems: 100,
		cursor: token,
	})
	expect(next.page.map((l: { _id: string }) => l._id)).toEqual([
		rows.labels[1]._id,
		rows.labels[4]._id,
		rows.labels[5]._id,
	])
	await expect(
		client.query(anyApi.functions.next, {
			parent: rows.labels[1]._id,
			numItems: 100,
			cursor: token,
		}),
	).rejects.toThrow()
	await f.t.run((ctx) => ctx.db.patch(rows.tasks[1]._id, { allowed: false }))
	expect(
		(
			await client.query(anyApi.functions.next, {
				parent: rows.tasks[1]._id,
				numItems: 100,
				cursor: token,
			})
		).page,
	).toEqual([])
})

test('U6 nullish references never scan targets and missing memo entries remain request-local', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const p = await f
			.querying(o.ctx)
			.tasks.with({ referenceTask: true })
			.paginate({ numItems: 100, cursor: null, filters: { ordinal: { gte: 3 } } })
		expect(p.page.map((t) => t.referenceTask)).toEqual([null, null, null])
		expect(o.counts.gets).toBe(0)
		expect(o.counts.ranges).toBe(1)
	})
	await f.t.run((ctx) => ctx.db.delete(rows.labels[1]._id))
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const p = await f
			.querying(o.ctx)
			.tasks.with({ requiredLabel: true, labels: true, aliasLabels: true })
			.paginate({ numItems: 100, cursor: null })
		expect(p.page.every((t) => t.requiredLabel === null)).toBe(true)
		expect(p.page.slice(0, 3).map((t) => t.labels.page.map((l) => l._id))).toEqual(
			Array.from({ length: 3 }, () => [rows.labels[4]._id, rows.labels[5]._id]),
		)
		expect(o.counts.gets).toBe(5) // one missing, two denied and two authorized ID reads.
	})
})

test('U6 shared budget partial pages advance only fully completed parents without skipping output', async () => {
	const f = relationshipFixture({ readOperations: 3 }),
		rows = await seedRelationships(f)
	let token: string | null = null
	const actual: string[] = []
	for (let page = 0; page < 10; page++) {
		const p = await f.t.run(async (ctx) => {
			const o = f.context(ctx.db)
			const result = await f
				.querying(o.ctx)
				.tasks.with({ referenceTask: true })
				.paginate({ numItems: 100, cursor: token })
			expect(o.counts.next + o.counts.gets).toBeLessThanOrEqual(3)
			return result
		})
		actual.push(...p.page.map((t) => t._id))
		if (p.isDone) break
		expect(p.continueCursor).not.toBe(token)
		token = p.continueCursor
		expect(page).toBeLessThan(9)
	}
	expect(actual).toEqual(rows.tasks.slice(1).map((t) => t._id))
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const q = createQueryEngine({
			schema: f.schema,
			relations: f.relations,
			cursor,
			budgets: { readOperations: 2 },
		})
		await expect(
			q(o.ctx).tasks.with({ referenceTask: true }).paginate({ numItems: 100, cursor: null }),
		).rejects.toMatchObject({ code: 'MANAGED_READ_BUDGET' })
		expect(o.counts.next).toBe(2)
		expect(o.counts.gets).toBe(0)
	})
})

test('U6 junction policy reads are authorized and share budgets with eligibility traversal', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const policy = managed(o.raw, {
			tasks: { read: async (_, t) => t.allowed },
			labels: { read: async (_, l) => l.allowed && l.tenant === 'one' },
			edges: { read: async ({ db }, e) => e.allowed && !!(await db.get('labels', e.label)) },
		})
		const q = createQueryEngine({
			schema: f.schema,
			relations: f.relations,
			cursor,
			budgets: { readOperations: 4 },
		})
		await expect(
			q(policy).tasks.paginate({
				numItems: 1,
				cursor: null,
				filters: { _id: rows.tasks[1]._id, labels: { none: {} } },
			}),
		).rejects.toMatchObject({ code: 'MANAGED_READ_BUDGET' })
		expect(o.counts.next + o.counts.gets).toBe(4)
		expect(o.counts.gets).toBe(1)
		expect(o.counts.closes).toBe(o.counts.ranges)
	})
})

test('U6 nested continuation rechecks revoked junction and target ancestry before output', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	const first = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.tasks.with({ labels: { owner: { labels: true } } })
			.paginate({ numItems: 1, cursor: null, filters: { _id: rows.tasks[1]._id } }),
	)
	const token = first.page[0].labels.page[0].owner!.labels.continueCursor
	const relevant = rows.edges.filter(
		(e) => e.task === rows.tasks[1]._id && e.label === rows.labels[1]._id,
	)
	await f.t.run(async (ctx) => {
		for (const e of relevant) await ctx.db.patch(e._id, { allowed: false })
	})
	const resume = () =>
		f.t.run((ctx) =>
			f
				.querying(f.context(ctx.db).ctx)
				.tasks.relation(rows.tasks[1]._id, 'labels.owner.labels')
				.paginate({ numItems: 100, cursor: token }),
		)
	expect((await resume()).page).toEqual([])
	await f.t.run(async (ctx) => {
		for (const e of relevant) await ctx.db.patch(e._id, { allowed: true })
		await ctx.db.patch(rows.labels[1]._id, { allowed: false })
	})
	expect((await resume()).page).toEqual([])
})

test('U6 relation conditional indexes use guaranteed foreign-key prefixes and reject incompatible choices', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const q = f.querying(o.ctx).tasks.relation(rows.tasks[1]._id, 'direct')
		const p = await q
			.when(true, 'by_task_code')
			.paginate({ numItems: 1, cursor: null, filters: { code: 'c4' } })
		expect(p.page.map((l) => l._id)).toEqual([rows.labels[4]._id])
		expect(o.counts.returned).toBe(1)
		const before = { ...o.counts }
		await expect(
			q.when(true, 'by_code').paginate({ numItems: 1, cursor: null, filters: { code: 'shared' } }),
		).rejects.toThrow('incompatible')
		expect(o.counts).toEqual(before)
		await expect(
			q
				.when(true, 'by_task')
				.paginate({ numItems: 1, cursor: p.continueCursor, filters: { code: 'c4' } }),
		).rejects.toThrow('Invalid cursor')
		expect(o.counts).toEqual(before)
	})
})

test('U6 compatible relation index choices determine direct order and inner junction prefixes', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	for (const order of ['asc', 'desc'] as const) {
		const expected = [3, 4, 5, 6, 7, 1].map((i) => rows.labels[i]._id)
		if (order === 'desc') expected.reverse()
		let token: string | null = null
		const actual: string[] = []
		for (let page = 0; page < 10; page++) {
			const p = await f.t.run((ctx) =>
				f
					.querying(f.context(ctx.db).ctx)
					.tasks.relation(rows.tasks[1]._id, 'direct')
					.when(false, 'by_task_code')
					.when(true, 'by_task')
					.paginate({ numItems: 2, cursor: token, order }),
			)
			actual.push(...p.page.map((l) => l._id))
			if (p.isDone) break
			token = p.continueCursor
			expect(page).toBeLessThan(9)
		}
		expect(actual).toEqual(expected)
	}
	await f.t.run((ctx) => ctx.db.patch(rows.labels[4]._id, { code: 'shared' }))
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db),
			q = f.querying(o.ctx).tasks.relation(rows.tasks[1]._id, 'codeLabels')
		const p = await q
			.when(0, 'by_code_ordinal')
			.paginate({ numItems: 100, cursor: null, filters: { ordinal: 4 } })
		expect(p.page.map((l) => l._id)).toEqual([
			rows.labels[4]._id,
			rows.labels[4]._id,
			rows.labels[4]._id,
		])
		expect(o.counts.returned).toBe(10) // seven junctions plus three exactly bound target matches.
		const before = { ...o.counts }
		await expect(
			q
				.when(true, 'by_code')
				.paginate({ numItems: 100, cursor: p.continueCursor, filters: { ordinal: 4 } }),
		).rejects.toThrow('Invalid cursor')
		await expect(
			f
				.querying(o.ctx)
				.tasks.relation(rows.tasks[1]._id, 'labels')
				.when(true, 'by_code')
				.paginate({ numItems: 1, cursor: null, filters: { code: 'shared' } }),
		).rejects.toThrow('incompatible')
		expect(o.counts).toEqual(before)
		const ranged = await q
			.when(0, 'by_code_ordinal')
			.paginate({ numItems: 100, cursor: null, filters: { ordinal: { gte: 4, lte: 4 } } })
		expect(ranged.page).toEqual(p.page)
		expect(o.counts.returned - before.returned).toBe(10) // every edge, plus the three native ranged targets
		const occurrences: string[] = []
		let token: string | null = null
		for (let n = 0; n < 8; n++) {
			const page = await q
				.when(0, 'by_code_ordinal')
				.paginate({ numItems: 1, cursor: token, filters: { ordinal: { gte: 4, lte: 4 } } })
			occurrences.push(...page.page.map((r) => r._id))
			if (page.isDone) break
			expect(page.continueCursor).not.toBe(token)
			token = page.continueCursor
			expect(n).toBeLessThan(7)
		}
		expect(occurrences).toEqual([rows.labels[4]._id, rows.labels[4]._id, rows.labels[4]._id])
	})
})

for (const kind of ['plain', 'structured'] as const)
	for (const table of ['tasks', 'edges', 'labels'] as const)
		test(`U6 correction registered ${kind} ${table} continuation errors are redacted`, async () => {
			let failing = false
			let policies = { tasks: 0, edges: 0, labels: 0 }
			const f = relationshipAuthFixture({
				beforeRead: async (reading) => {
					if (failing) policies[reading]++
					if (failing && reading === table)
						throw kind === 'plain'
							? new Error('PRIVATE_POLICY_DETAIL')
							: new ConvexError({ private: 'PRIVATE_POLICY_DETAIL' })
				},
			})
			const rows = await seedRelationships(f)
			const client = f.t.withIdentity({ subject: 'one-user', org_id: 'one', role: 'owner' })
			const first = await client.query(anyApi.functions.nestedPage, {
				numItems: 1,
				cursor: null,
				filters: { ordinal: 1 },
			})
			const token = first.page[0].labels.page[0].owner.labels.continueCursor
			failing = true
			const calls = [
				() =>
					client.query(anyApi.functions.nestedNext, {
						parent: rows.tasks[1]._id,
						numItems: 1,
						cursor: token,
					}),
			]
			if (table === 'tasks')
				calls.push(
					() => client.query(anyApi.functions.page, { numItems: 1, cursor: null }),
					() =>
						client.query(anyApi.functions.next, {
							parent: rows.tasks[1]._id,
							numItems: 1,
							cursor: null,
						}),
				)
			for (const call of calls) {
				policies = { tasks: 0, edges: 0, labels: 0 }
				const error = await call().then(
					() => null,
					(e: Error & { data?: Value }) => e,
				)
				expect(error).toBeInstanceOf(Error)
				expect.soft(error).toMatchObject({ message: 'Query execution failed' })
				expect.soft(error?.data).toBeUndefined()
				expect(policies).toEqual({
					tasks: 1,
					edges: table === 'tasks' ? 0 : 1,
					labels: table === 'labels' ? 1 : 0,
				})
			}
		})

for (const permitted of [false, true])
	test(`U6 owned indexed target remains isolated after async policy ${permitted} with live authorization`, async () => {
		const f = relationshipFixture(),
			rows = await seedRelationships(f)
		await f.t.run(async (ctx) => {
			const o = f.context(ctx.db)
			let policies = 0
			const def = f.labels.schema.shape.ordinal._zod.def
			const policy = managed(o.raw, {
				tasks: { read: async (_, row) => row.allowed },
				labels: {
					read: async () => {
						await Promise.resolve()
						policies++
						Reflect.set(def, 'type', 'string')
						return permitted
					},
				},
			})
			try {
				const pending = f
					.querying(policy)
					.tasks.with({ byCode: true })
					.paginate({
						numItems: 1,
						cursor: null,
						filters: { _id: rows.tasks[1]._id },
					})
				if (permitted) await expect(pending).rejects.toThrow('AMBIGUOUS_RELATION')
				else await expect(pending).resolves.toMatchObject({ page: [{ byCode: null }] })
				expect(policies).toBe(2)
				expect(o.counts.closes).toBe(2)
			} finally {
				Reflect.set(def, 'type', 'number')
			}
		})
	})

test('U6 correction rejects absolute route plus selection overflow before reads', async () => {
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		// SAFETY: deliberately erase the depth constraint to exercise runtime rejection before reads.
		await expect(
			f
				.querying(o.ctx)
				.tasks.relation(rows.tasks[1]._id, 'labels')
				.with({ owner: { labels: { owner: { labels: true } } } } as never)
				.paginate({ numItems: 1, cursor: null }),
		).rejects.toThrow('INVALID_RELATION')
		expect(o.counts).toEqual({ next: 0, returned: 0, ranges: 0, gets: 0, closes: 0 })
	})
})

for (const order of ['asc', 'desc'] as const)
	test(`U6 correction absolute depth four incomplete many page resumes with multiplicity ${order}`, async () => {
		const f = relationshipFixture(),
			rows = await seedRelationships(f)
		// Nested routes require authenticated ancestry from selected root output.
		const root = await f.t.run((ctx) =>
			f
				.querying(f.context(ctx.db).ctx)
				.tasks.with({ referenceTask: { labels: { owner: { labels: true } } } })
				.paginate({ numItems: 1, cursor: null, order, filters: { ordinal: 1 } }),
		)
		const nested = root.page[0].referenceTask!.labels.page[0].owner!.labels
		expect(nested.isDone).toBe(false)
		const expected = rows.edges
			.filter((e) => e.task === rows.tasks[1]._id && e.allowed)
			.flatMap((e) =>
				rows.labels
					.filter((l) => l._id === e.label && l.allowed && l.tenant === 'one')
					.map((l) => l._id),
			)
		if (order === 'desc') expected.reverse()
		const actual = nested.page.map((l) => l._id)
		let token = nested.continueCursor
		for (let page = 0; page < 10; page++) {
			const next = await f.t.run((ctx) =>
				f
					.querying(f.context(ctx.db).ctx)
					.tasks.relation(rows.tasks[1]._id, 'referenceTask.labels.owner.labels')
					.paginate({ numItems: page % 2 ? 2 : 1, cursor: token, order }),
			)
			actual.push(...next.page.map((l) => l._id))
			if (next.isDone) break
			expect(next.continueCursor).not.toBe(token)
			token = next.continueCursor
			expect(page).toBeLessThan(9)
		}
		expect(actual).toEqual(expected)
		const intermediate = await f.t.run((ctx) =>
			f
				.querying(f.context(ctx.db).ctx)
				.tasks.relation(rows.tasks[1]._id, 'referenceTask.labels')
				.with({ owner: { labels: true } })
				.paginate({
					numItems: 1,
					cursor: root.page[0].referenceTask!.labels.continueCursor,
					order,
				}),
		)
		expect(intermediate.page[0].owner!.labels.isDone).toBe(false)
	})

test('U6 correction registered continuation retains safe typed budget and cursor errors', async () => {
	const f = relationshipAuthFixture({ budgets: { readOperations: 1 } }),
		rows = await seedRelationships(f)
	const client = f.t.withIdentity({ subject: 'one-user', org_id: 'one', role: 'owner' })
	for (const [cursor, code, message] of [
		[null, 'MANAGED_READ_BUDGET', 'MANAGED_READ_BUDGET'],
		['invalid-token', 'invalid-cursor', 'Invalid cursor'],
	] as const) {
		const error = await client
			.query(anyApi.functions.next, {
				parent: rows.tasks[1]._id,
				numItems: 1,
				cursor,
			})
			.then(
				() => null,
				(e: Error & { data?: Value }) => e,
			)
		expect(error).toMatchObject({ code, message })
		expect(error?.data).toBeUndefined()
	}
})

test.each([0, 60])(
	'registry with %i unrelated tables does not rebuild serialized native exports per relational row',
	async (extra) => {
		const f = relationshipFixture(undefined, extra)
		const seeded = await seedRelationships(f)
		await f.t.run(async (ctx) => {
			for (const task of seeded.tasks) await ctx.db.delete(task._id)
			for (let ordinal = 0; ordinal < 11; ordinal++)
				await ctx.db.insert('tasks', {
					ordinal,
					code: 'probe',
					required: seeded.labels[1]._id,
					allowed: true,
					tenant: 'one',
				})
		})
		await f.t.run(async (ctx) => {
			const o = f.context(ctx.db)
			const originals = new Set<object>()
			// oxlint-disable-next-line anti-slop/no-object-parameters -- Collect identity targets without reading any caller accessor.
			function collect(object: object): void {
				if (originals.has(object)) return
				originals.add(object)
				for (const property of Object.values(Object.getOwnPropertyDescriptors(object)))
					if (
						'value' in property &&
						property.value instanceof Object &&
						!(property.value instanceof Function)
					)
						collect(property.value)
			}
			collect(f.schema.tables)
			collect(f.tasks.schema)
			collect(f.labels.schema)
			collect(f.edges.schema)
			const descriptor = Object.getOwnPropertyDescriptor
			let originalReads = 0
			const descriptors = vi
				.spyOn(Object, 'getOwnPropertyDescriptor')
				.mockImplementation((object, key) => {
					if (originals.has(object)) originalReads++
					return descriptor(object, key)
				})
			const original = JSON.stringify
			let exports = 0
			const spy = vi.spyOn(JSON, 'stringify').mockImplementation((...args) => {
				if (args[0] && Object.hasOwn(args[0], 'documentType') && Object.hasOwn(args[0], 'indexes'))
					exports++
				return original(...args)
			})
			try {
				const query = f
					.querying(o.ctx)
					.tasks.with({ referenceTask: true, requiredLabel: true, direct: true })
				for (const pass of [1, 2]) {
					const result = await query.paginate({
						numItems: 10,
						cursor: null,
						filters: { code: 'probe' },
					})
					expect(result.page.map((row) => row.ordinal)).toEqual(
						Array.from({ length: 10 }, (_, i) => i),
					)
					expect(
						result.page.every(
							(row) =>
								row.requiredLabel?._id === seeded.labels[1]._id &&
								row.referenceTask === null &&
								row.direct.page.length === 0,
						),
					).toBe(true)
					expect(o.counts).toEqual({
						next: 20 * pass,
						returned: 10 * pass,
						ranges: 11 * pass,
						gets: 1,
						closes: 11 * pass,
					})
				}
				expect(exports).toBe(0)
				expect(originalReads).toBe(0)
			} finally {
				spy.mockRestore()
				descriptors.mockRestore()
			}
		})
	},
	20000,
)

test('phase A direct ordering and ranges retain cursors; unsupported paths reject before reads', async () => {
	// SAFETY: this runtime fixture discards index builder types; registry validation admits the declared names.
	const f = relationshipFixture(),
		rows = await seedRelationships(f)
	for (const order of ['asc', 'desc'] as const)
		await f.t.run(async (ctx) => {
			const o = f.context(ctx.db),
				base = f.querying(o.ctx).tasks
			const q = base.relation(rows.tasks[1]._id, 'direct').orderBy('by_task_code' as never)
			const args = {
				numItems: 100,
				cursor: null,
				order,
				filters: { code: { gte: 'c3', lt: 'shared' } },
			} as const
			const full = await q.paginate(args)
			const expected = rows.labels
				.filter((r) => r.allowed && r.tenant === 'one' && r.code >= 'c3' && r.code < 'shared')
				.sort((a, b) => a.code.localeCompare(b.code))
			if (order === 'desc') expected.reverse()
			expect(full.page.map((r) => r._id)).toEqual(expected.map((r) => r._id))
			expect(o.counts.returned).toBe(expected.length)
			const first = await q.paginate({ ...args, numItems: 2 })
			const rest = await q.paginate({ ...args, cursor: first.continueCursor })
			expect([...first.page, ...rest.page]).toEqual(full.page)
			const split = await q.paginate({ ...args, maximumRowsRead: 3 })
			expect(split.splitCursor).toMatch(/^pc\./)
			const left = await q.paginate({ ...args, endCursor: split.splitCursor })
			const right = await q.paginate({
				...args,
				cursor: split.splitCursor!,
				endCursor: split.continueCursor,
			})
			expect([...left.page, ...right.page]).toEqual(split.page)
			const tail = await q.paginate({ ...args, cursor: split.continueCursor })
			expect([...split.page, ...tail.page]).toEqual(full.page)

			const candidates = o.counts.returned
			expect((await q.where({ task: rows.tasks[2]._id }).paginate(args)).page).toEqual([])
			expect(o.counts.returned).toBe(candidates)

			const before = { ...o.counts }
			for (const slot of ['cursor', 'endCursor'] as const) {
				await expect(
					base
						.relation(rows.tasks[1]._id, 'direct')
						.orderBy('by_task' as never)
						.paginate({ ...args, [slot]: first.continueCursor }),
				).rejects.toThrow('Invalid cursor')
				await expect(
					q.paginate({
						...args,
						[slot]: first.continueCursor,
						order: order === 'asc' ? 'desc' : 'asc',
					}),
				).rejects.toThrow('Invalid cursor')
				await expect(
					q.paginate({ ...args, [slot]: first.continueCursor, filters: { code: { lt: 'c7' } } }),
				).rejects.toThrow('Invalid cursor')
			}
			await expect(
				base
					.relation(rows.tasks[1]._id, 'direct')
					.orderBy('by_code' as never)
					.paginate(args),
			).rejects.toThrow('incompatible')
			for (const path of ['labels', 'codeLabels', 'labels.owner.direct'] as const)
				await expect(
					base
						.relation(rows.tasks[1]._id, path)
						.orderBy('by_task_code' as never)
						.paginate(args),
				).rejects.toThrow('orderBy')
			await expect(q.when(true, 'by_task').paginate(args)).rejects.toThrow('orderBy')
			expect(o.counts).toEqual(before)
		})
})

test('U4 direct lookup expansion and through residuals retain authorized edge occurrences', async () => {
	const f = relationshipFixture()
	const rows = await seedRelationships(f)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const q = f.querying(o.ctx).tasks
		const values = ['shared', 'c3', 'c4', 'c5']
		for (const relation of ['direct', 'labels', 'codeLabels'] as const) {
			const query = q.relation(rows.tasks[1]._id, relation)
			const expected = await query.paginate({
				numItems: 100,
				cursor: null,
				filters: { or: [{ code: 'shared' }, { code: 'c3' }, { code: 'c4' }, { code: 'c5' }] },
			})
			const seen: string[] = []
			let token: string | null = null
			for (let i = 0; i < 30; i++) {
				const page = await query.paginate({
					numItems: 1,
					cursor: token,
					filters: { code: { in: values } },
				})
				seen.push(...page.page.map((row) => row._id))
				if (page.isDone) break
				token = page.continueCursor
			}
			expect(seen).toEqual(expected.page.map((row) => row._id))
			const partial = await query.paginate({
				numItems: 100,
				cursor: null,
				maximumRowsRead: 2,
				filters: { code: { in: values } },
			})
			expect(partial.splitCursor).toBeTruthy()
			const left = await query.paginate({
				numItems: 100,
				cursor: null,
				endCursor: partial.splitCursor,
				filters: { code: { in: values } },
			})
			const right = await query.paginate({
				numItems: 100,
				cursor: partial.splitCursor!,
				endCursor: partial.continueCursor,
				filters: { code: { in: values.slice().reverse() } },
			})
			expect([...left.page, ...right.page]).toEqual(partial.page)
			if (relation !== 'direct')
				expect(seen.filter((id) => id === rows.labels[1]._id)).toHaveLength(
					rows.edges.filter(
						(edge) =>
							edge.task === rows.tasks[1]._id &&
							edge.allowed &&
							(relation === 'labels'
								? edge.label === rows.labels[1]._id
								: edge.labelCode === rows.labels[1].code),
					).length,
				)
			if (relation === 'direct') {
				for (const order of ['asc', 'desc'] as const) {
					// SAFETY: this fixture mutates labels.table to declare by_task_code; its schema type erases those index names.
					const full = await query
						.orderBy('by_task_code' as never)
						.paginate({ numItems: 100, cursor: null, order, filters: { code: { in: values } } })
					const codes = full.page.map((row) => row.code)
					expect(codes).toEqual(
						[...codes].sort((a, b) => a.localeCompare(b) * (order === 'asc' ? 1 : -1)),
					)
				}
			}
		}
		expect(o.counts.closes).toBe(o.counts.ranges)
	})
})
