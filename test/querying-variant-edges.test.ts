import { expect, test } from 'vite-plus/test'
import { variantEdgesFixture } from './fixture-querying/variant-edges'

test('guard-only join index preserves exact relation IDs, eligibility, nested output and continuation', async () => {
	const f = variantEdgesFixture()
	const ids = await f.t.run(async (ctx) => {
		const creditor = await ctx.db.insert('creditors', { name: 'Matching' })
		const wrongBranchOnly = await ctx.db.insert('creditors', { name: 'Draft only' })
		const empty = await ctx.db.insert('creditors', { name: 'Empty' })
		const expected = []
		for (let n = 0; n < 6; n++) {
			const id = await ctx.db.insert('payments', {
				type: n % 2 ? 'creditor' : 'draft',
				creditorId: creditor,
				amount: n,
			})
			if (n % 2) expected.push(id)
		}
		await ctx.db.insert('payments', { type: 'draft', creditorId: wrongBranchOnly, amount: 99 })
		return { creditor, wrongBranchOnly, empty, expected }
	})
	for (const order of ['asc', 'desc'] as const) {
		const expected = order === 'asc' ? ids.expected : [...ids.expected].reverse()
		const actual: string[] = []
		let cursor: string | null = null
		for (let n = 0; n < 8; n++) {
			const result = await f.t.run((ctx) =>
				f
					.querying(f.context(ctx.db).ctx)
					.creditors.relation(ids.creditor, 'payments')
					.paginate({ numItems: 1, cursor, order }),
			)
			actual.push(...result.page.map((row) => row._id))
			if (result.isDone) break
			expect(result.continueCursor).not.toBe(cursor)
			cursor = result.continueCursor
			expect(n).toBeLessThan(7)
		}
		expect(actual).toEqual(expected)
	}
	await f.t.run(async (ctx) => {
		const q = f.querying(f.context(ctx.db).ctx).creditors
		const direct = await q
			.relation(ids.creditor, 'payments')
			.paginate({ numItems: 10, cursor: null })
		expect(direct.page.map((row) => row._id)).toEqual(ids.expected)
		const eligible = await q.paginate({
			numItems: 10,
			cursor: null,
			filters: { payments: { some: { amount: { gte: 0 } } } },
		})
		expect(eligible.page.map((row) => row._id)).toEqual([ids.creditor])
		const absent = await q.paginate({
			numItems: 10,
			cursor: null,
			filters: { payments: { none: { amount: { gte: 0 } } } },
		})
		expect(absent.page.map((row) => row._id)).toEqual([ids.wrongBranchOnly, ids.empty])
		const nested = await q.with({ payments: true }).paginate({ numItems: 10, cursor: null })
		expect(nested.page.map((row) => row.payments.page.map((payment) => payment._id))).toEqual([
			ids.expected,
			[],
			[],
		])
		expect(f.relations.tables.creditors.pageDto({ payments: true }).parse(nested)).toEqual(nested)
	})
})

test('variant filter depth boundary and cloned grammar agree with runtime preflight', async () => {
	const f = variantEdgesFixture()
	const input = f.relations.tables.payments.paginationOpts({
		variants: { creditor: { amount: true } },
	})
	// Three boolean edges plus the variant edge reach the supported depth of four.
	const boundary = {
		not: { not: { not: { variant: { tag: 'creditor', filters: { amount: 7 } } } } },
	} as const
	const beyond = { not: boundary }
	for (const schema of [input, input.clone()]) {
		expect(schema.safeParse({ numItems: 1, cursor: null, filters: boundary }).success).toBe(true)
		expect(schema.safeParse({ numItems: 1, cursor: null, filters: beyond }).success).toBe(false)
	}
	const ids = await f.t.run(async (ctx) => {
		const creditorId = await ctx.db.insert('creditors', { name: 'C' })
		await ctx.db.insert('payments', { type: 'creditor', creditorId, amount: 7 })
		const other = await ctx.db.insert('payments', { type: 'creditor', creditorId, amount: 8 })
		const draft = await ctx.db.insert('payments', { type: 'draft', creditorId, amount: 7 })
		return [other, draft]
	})
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db),
			q = f.querying(o.ctx).payments
		const result = await q.paginate({ numItems: 10, cursor: null, filters: boundary })
		expect(result.page.map((row) => row._id)).toEqual(ids)
	})
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		// SAFETY: one excessive depth edge deliberately bypasses the typed filter contract.
		await expect(
			f.querying(o.ctx).payments.paginate({ numItems: 1, cursor: null, filters: beyond as never }),
		).rejects.toThrow()
		expect(o.counts.next + o.counts.gets + o.counts.ranges).toBe(0)
	})
})

test.each(['tag', 'filters'] as const)(
	'variant accessor %s rejects without getter calls or reads',
	async (key) => {
		const f = variantEdgesFixture()
		const input = f.relations.tables.payments.paginationOpts({
			variants: { creditor: { amount: true } },
		})
		let calls = 0
		const variant = { tag: 'creditor', filters: { amount: 7 } }
		Object.defineProperty(variant, key, {
			enumerable: true,
			get() {
				calls++
				return key === 'tag' ? 'creditor' : { amount: 7 }
			},
		})
		for (const schema of [input, input.clone()])
			expect(schema.safeParse({ numItems: 1, cursor: null, filters: { variant } }).success).toBe(
				false,
			)
		await f.t.run(async (ctx) => {
			const o = f.context(ctx.db)
			// SAFETY: accessor-backed input is hostile transport data, not a typed consumer filter.
			await expect(
				f
					.querying(o.ctx)
					.payments.paginate({ numItems: 1, cursor: null, filters: { variant } as never }),
			).rejects.toThrow()
			expect(o.counts.next + o.counts.gets + o.counts.ranges).toBe(0)
		})
		expect(calls).toBe(0)
	},
)

test('branch-scoped junction legs and guarded non-ID expansion retain occurrences across continuation', async () => {
	const f = variantEdgesFixture()
	const ids = await f.t.run(async (ctx) => {
		const creditorId = await ctx.db.insert('creditors', { name: 'C' })
		const payment = await ctx.db.insert('payments', { type: 'creditor', creditorId, amount: 1 })
		const otherParent = await ctx.db.insert('payments', { type: 'creditor', creditorId, amount: 2 })
		const a = await ctx.db.insert('attachments', { type: 'file', code: 'a', name: 'A' })
		await ctx.db.insert('attachments', { type: 'other', code: 'a', name: 'Wrong target branch' })
		const b = await ctx.db.insert('attachments', { type: 'file', code: 'b', name: 'B' })
		const wrongOnly = await ctx.db.insert('attachments', {
			type: 'file',
			code: 'wrong',
			name: 'Wrong junction',
		})
		for (const [type, code] of [
			['other', 'wrong'],
			['attachment', 'a'],
			['other', 'a'],
			['attachment', 'a'],
			['other', 'b'],
			['attachment', 'b'],
			['attachment', 'a'],
			['other', 'wrong'],
		] as const)
			await ctx.db.insert('links', { type, paymentId: payment, code })
		await ctx.db.insert('links', { type: 'attachment', paymentId: otherParent, code: 'wrong' })
		return { payment, a, b, wrongOnly }
	})
	const first = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.payments.with({ attachments: true })
			.paginate({ numItems: 1, cursor: null }),
	)
	const nested = first.page[0].attachments
	expect(first.page[0]._id).toBe(ids.payment)
	expect(nested.page.map((row) => row._id)).toEqual([ids.a])
	expect(nested.isDone).toBe(false)
	const actual = nested.page.map((row) => row._id)
	let cursor = nested.continueCursor
	for (let n = 0; n < 8; n++) {
		const next = await f.t.run((ctx) =>
			f
				.querying(f.context(ctx.db).ctx)
				.payments.relation(ids.payment, 'attachments')
				.paginate({ numItems: 1, cursor }),
		)
		actual.push(...next.page.map((row) => row._id))
		if (next.isDone) break
		expect(next.continueCursor).not.toBe(cursor)
		cursor = next.continueCursor
		expect(n).toBeLessThan(7)
	}
	expect(actual).toEqual([ids.a, ids.a, ids.b, ids.a])
	await f.t.run(async (ctx) => {
		const q = f.querying(f.context(ctx.db).ctx).payments
		const direct = await q
			.relation(ids.payment, 'attachments')
			.paginate({ numItems: 10, cursor: null })
		expect(direct.page.map((row) => row._id)).toEqual(actual)
		const eligible = await q.paginate({
			numItems: 10,
			cursor: null,
			filters: { attachments: { some: { name: 'B' } } },
		})
		expect(eligible.page.map((row) => row._id)).toEqual([ids.payment])
		const wrong = await q.paginate({
			numItems: 10,
			cursor: null,
			filters: { _id: ids.payment, attachments: { some: { name: 'Wrong junction' } } },
		})
		expect(wrong.page).toEqual([])
	})
})
