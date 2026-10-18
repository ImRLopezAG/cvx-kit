import { expect, test } from 'vite-plus/test'
import {
	variantFixture,
	seedVariants,
	variantDeclarations,
	corruptVariantRow,
} from './fixture-querying/variants'
import { cursor, managed, observed } from './fixture-querying/scalar'
import { getRelationMetadata } from '../src/relations'
import { z } from 'zod'
import { zid } from 'convex-helpers/server/zod4'
import { defineRelations } from '../src/relations-public'
import { zodTable, zodVariantTable } from '../src/zod-table'
import { defineSchema, type DataModelFromSchemaDefinition } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { createQueryEngine } from '../src/querying'

test.each(['variant', 'variants'] as const)(
	'variant tables reject reserved relation name %s at registration',
	(name) => {
		expect(() =>
			defineRelations(variantDeclarations(), (r) => ({
				// SAFETY: untrusted relation names deliberately bypass the declaration contract.
				payments: {
					[name]: r.one.clients({ from: r.payments.clientId, to: r.clients._id }),
				} as never,
			})),
		).toThrow(`Relation name collision "${name}"`)
	},
)

test('ordinary tables preserve variant and variants relation names', () => {
	const relations = defineRelations(variantDeclarations(), (r) => ({
		clients: {
			variant: r.many.payments({ from: r.clients._id, to: r.payments.clientId }),
			variants: r.many.payments({ from: r.clients._id, to: r.payments.clientId }),
		},
	}))
	const input = relations.tables.clients.paginationOpts({
		variant: { amountCents: true },
		variants: { amountCents: true },
	})
	expect(
		input.safeParse({
			numItems: 1,
			cursor: null,
			filters: { variant: { some: { amountCents: 1 } }, variants: { some: { amountCents: 2 } } },
		}).success,
	).toBe(true)
})

test('empty-string branch public pagination and engine filters agree', async () => {
	const records = zodVariantTable(
		'records',
		z.discriminatedUnion('type', [
			z.strictObject({ type: z.literal(''), onlyEmpty: z.number() }),
			z.strictObject({ type: z.literal('other'), onlyOther: z.number() }),
		]),
		{
			discriminator: 'type',
			variants: {
				'': { publicFields: ['onlyEmpty'] },
				other: { publicFields: ['onlyOther'] },
			},
		},
	)
	const relations = defineRelations({ records }, () => ({}))
	const schema = defineSchema({ records: records.table })
	const { createTest } = defineTestApp({ schema }).defineModules({})
	const t = createTest()
	const querying = createQueryEngine({ schema, relations }, { cursor })
	const input = relations.tables.records.paginationOpts({
		variants: { '': { onlyEmpty: true }, other: { onlyOther: true } },
	})
	await t.run(async (ctx) => {
		const empty = await ctx.db.insert('records', { type: '', onlyEmpty: 1 })
		await ctx.db.insert('records', { type: '', onlyEmpty: 2 })
		const other = await ctx.db.insert('records', { type: 'other', onlyOther: 1 })
		for (const [filters, expected] of [
			[{ variant: { tag: '', filters: { onlyEmpty: 1 } } }, [empty]],
			[{ variant: { tag: 'other', filters: { onlyOther: 1 } } }, [other]],
		] as const) {
			const args = input.parse({ numItems: 10, cursor: null, filters })
			const result = await querying(
				managed<DataModelFromSchemaDefinition<typeof schema>>(ctx.db),
			).records.paginate(args)
			expect(result.page.map((row) => row._id)).toEqual(expected)
			expect(relations.tables.records.pageDto({}).parse(result)).toEqual(result)
		}
		const mixed = await querying(
			managed<DataModelFromSchemaDefinition<typeof schema>>(ctx.db),
		).records.paginate({ numItems: 10, cursor: null })
		expect(mixed.page).toHaveLength(3)
	})
})

test('branch reference keys distinguish NUL characters in table and tag', () => {
	const first = zodVariantTable(
		'scope',
		z.discriminatedUnion('type', [
			z.strictObject({ type: z.literal('\0branch'), token: z.string() }),
			z.strictObject({ type: z.literal('other'), token: z.string() }),
		]),
		{ discriminator: 'type', variants: { '\0branch': {}, other: {} } },
	)
	const second = zodVariantTable(
		'scope\0',
		z.discriminatedUnion('type', [
			z.strictObject({ type: z.literal('branch'), token: z.string() }),
			z.strictObject({ type: z.literal('other'), token: z.string() }),
		]),
		{ discriminator: 'type', variants: { branch: {}, other: {} } },
	)
	const target = zodTable('target', () => ({ token: z.string() }))
	target.table.index('by_token', ['token'])
	const relations = defineRelations({ scope: first, 'scope\0': second, target }, (r, branch) => ({
		scope: {
			target: r.one.target({ from: branch('scope', '\0branch').token, to: r.target.token }),
		},
		'scope\0': {
			target: r.one.target({ from: branch('scope\0', 'branch').token, to: r.target.token }),
		},
	}))
	const edges = getRelationMetadata(relations).declarations
	expect(edges.scope.target.source).toBe('scope')
	expect(edges['scope\0'].target.source).toBe('scope\0')
})

test('variant tables register and return authorized mixed branch DTOs with relations', async () => {
	const f = variantFixture()
	const rows = await seedVariants(f)
	await f.t.run(async (ctx) => {
		const result = await f
			.querying(f.context(ctx.db).ctx)
			.payments.with({ client: true })
			.paginate({
				numItems: 100,
				cursor: null,
			})
		expect(result.page.map((row) => row._id)).toEqual(
			rows.payments.filter((row) => row.allowed).map((row) => row._id),
		)
		expect(f.relations.tables.payments.pageDto({ client: true }).parse(result)).toEqual(result)
		for (const row of result.page) {
			expect(row.client?._id).toBe(rows.client)
			expect(row).not.toHaveProperty('external')
			expect(row).not.toHaveProperty('createdAt')
			expect(row).not.toHaveProperty('_creationTime')
			if (row.type === 'client_draft') expect(row).not.toHaveProperty('creditorId')
			else expect(row).not.toHaveProperty('draftDate')
		}
	})
})

// Source execution proofs; packed/published consumer verification belongs to the parent.
test('mixed continuation exhausts interleaved denied branches without gaps or repeats', async () => {
	const f = variantFixture(),
		rows = await seedVariants(f)
	for (const order of ['asc', 'desc'] as const)
		for (const size of [1, 2, 3]) {
			const actual: string[] = []
			let cursor: string | null = null
			for (let page = 0; page < 20; page++) {
				const result = await f.t.run((ctx) =>
					f.querying(f.context(ctx.db).ctx).payments.paginate({ numItems: size, cursor, order }),
				)
				actual.push(...result.page.map((row) => row._id))
				if (result.isDone) break
				expect(result.continueCursor).not.toBe(cursor)
				cursor = result.continueCursor
				expect(page).toBeLessThan(19)
			}
			const expected = rows.payments.filter((row) => row.allowed).map((row) => row._id)
			if (order === 'desc') expected.reverse()
			expect(actual).toEqual(expected)
			expect(new Set(actual).size).toBe(actual.length)
		}
})

test('common and branch relations retain parent constraints and branch eligibility', async () => {
	const f = variantFixture(),
		rows = await seedVariants(f)
	const other = await f.t.run((ctx) => ctx.db.insert('clients', { name: 'Other', allowed: true }))
	await f.t.run(async (ctx) => {
		const q = f.querying(f.context(ctx.db).ctx)
		const common = await q.clients
			.relation(rows.client, 'payments')
			.with({ client: true })
			.paginate({ numItems: 100, cursor: null })
		expect(common.page.map((r) => r._id)).toEqual(
			rows.payments.filter((r) => r.allowed).map((r) => r._id),
		)
		const scoped = await q.creditors
			.relation(rows.creditor, 'payments')
			.with({ creditor: true })
			.paginate({ numItems: 100, cursor: null })
		expect(scoped.page.map((r) => r._id)).toEqual(
			rows.payments.filter((r) => r.allowed && r.type === 'creditor_payment').map((r) => r._id),
		)
		for (const row of scoped.page) expect(row.creditor?._id).toBe(rows.creditor)
		const override = await q.clients
			.relation(rows.client, 'payments')
			.where({ clientId: other })
			.paginate({ numItems: 100, cursor: null })
		expect(override.page).toEqual([])
		const business = await q.payments
			.where({ amountCents: { gte: 6 } })
			.paginate({ numItems: 100, cursor: null, filters: { amountCents: { lt: 6 } } })
		expect(business.page).toEqual([])
		const related = await q.payments.paginate({
			numItems: 100,
			cursor: null,
			filters: { creditor: { name: 'Creditor' } },
		})
		expect(related.page.map((r) => r._id)).toEqual(scoped.page.map((r) => r._id))
		const absent = await q.payments.paginate({
			numItems: 100,
			cursor: null,
			filters: { creditor: null },
		})
		expect(absent.page.map((r) => r._id)).toEqual(
			rows.payments.filter((r) => r.allowed && r.type === 'client_draft').map((r) => r._id),
		)
	})
})

test('branch predicates compose boolean operators without widening contradictions', async () => {
	const f = variantFixture(),
		rows = await seedVariants(f)
	await f.t.run(async (ctx) => {
		const q = f.querying(f.context(ctx.db).ctx).payments
		const creditor = {
			variant: { tag: 'creditor_payment', filters: { creditorId: rows.creditor } },
		} as const
		const draft = { variant: { tag: 'client_draft', filters: { draftDate: { gte: 2 } } } } as const
		for (const [filters, indices] of [
			[creditor, [3, 5, 7]],
			[draft, [2, 6]],
			[{ or: [creditor, draft] }, [2, 3, 5, 6, 7]],
			[{ and: [creditor, { amountCents: { gte: 6 } }] }, [5, 7]],
			[{ not: creditor }, [0, 2, 6]],
			[{ and: [creditor, { type: 'client_draft' }] }, []],
			[{ and: [creditor, draft] }, []],
			[{ not: { or: [creditor, { type: 'client_draft' }] } }, []],
		] satisfies Array<[Parameters<typeof q.paginate>[0]['filters'], number[]]>) {
			const result = await q.paginate({ numItems: 100, cursor: null, filters })
			expect(result.page.map((r) => r._id)).toEqual(indices.map((i) => rows.payments[i]._id))
		}
		const input = f.relations.tables.payments.paginationOpts({
			type: true,
			clientId: true,
			variants: { creditor_payment: { creditorId: true }, client_draft: { draftDate: true } },
		})
		expect(input.safeParse({ numItems: 1, cursor: null, filters: creditor }).success).toBe(true)
		for (const filters of [
			{ creditorId: rows.creditor },
			{ draftDate: 0 },
			{ and: [{ creditorId: rows.creditor }] },
			{ or: [{ draftDate: 0 }] },
			{ not: { creditorId: rows.creditor } },
			{ variant: { tag: 'unknown', filters: {} } },
			{ variant: { tag: 'client_draft', filters: { creditorId: rows.creditor } } },
			{
				variant: {
					tag: 'creditor_payment',
					filters: { external: { providerId: 'PRIVATE-EVIDENCE' } },
				},
			},
		]) {
			expect(input.safeParse({ numItems: 1, cursor: null, filters }).success).toBe(false)
			// SAFETY: deliberately bypass TypeScript to test untrusted predicate rejection.
			await expect(
				q.paginate({ numItems: 1, cursor: null, filters: filters as never }),
			).rejects.toThrow()
		}
		const indexed = await q.paginate({
			numItems: 100,
			cursor: null,
			filters: { clientId: rows.client },
		})
		expect(indexed.page.map((r) => r._id)).toEqual(
			rows.payments.filter((r) => r.allowed).map((r) => r._id),
		)
		await expect(
			q.when(true, 'by_creditorId').paginate({ numItems: 100, cursor: null }),
		).rejects.toThrow()
		const explicit = await q
			.when(true, 'by_creditorId')
			.paginate({ numItems: 100, cursor: null, filters: creditor })
		expect(explicit.page.map((r) => r._id)).toEqual([3, 5, 7].map((n) => rows.payments[n]._id))
		await expect(
			q.when(true, 'by_creditorId').paginate({ numItems: 1, cursor: null, filters: draft }),
		).rejects.toThrow()
		expect(
			input.safeParse({ numItems: 1, cursor: null, filters: { amountCents: 1 } }).success,
		).toBe(false)
	})
})

test('attachment junction preserves duplicate occurrences and all three authorization gates', async () => {
	const f = variantFixture(),
		rows = await seedVariants(f)
	const ids = await f.t.run(async (ctx) => {
		const visible = await ctx.db.insert('attachments', {
			name: 'Visible',
			allowed: true,
			evidence: 'PRIVATE-EVIDENCE',
		})
		const denied = await ctx.db.insert('attachments', {
			name: 'Hidden',
			allowed: false,
			evidence: 'PRIVATE-EVIDENCE',
		})
		for (const payment of [rows.payments[0], rows.payments[1]]) {
			for (const [attachmentId, allowed] of [
				[denied, true],
				[visible, false],
				[visible, true],
				[visible, true],
				[visible, true],
			] as const)
				await ctx.db.insert('paymentAttachments', { paymentId: payment._id, attachmentId, allowed })
		}
		return { visible, denied }
	})
	const first = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.payments.with({ attachments: true })
			.paginate({ numItems: 1, cursor: null }),
	)
	expect(first.page[0].attachments.page.map((r) => r._id)).toEqual([ids.visible])
	expect(first.page[0].attachments.isDone).toBe(false)
	const rest = await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const page = await f
			.querying(o.ctx)
			.payments.relation(rows.payments[0]._id, 'attachments')
			.paginate({ numItems: 100, cursor: first.page[0].attachments.continueCursor })
		expect(o.counts.next + o.counts.gets).toBeLessThan(20)
		expect(o.counts.closes).toBe(o.counts.ranges)
		return page
	})
	expect([...first.page[0].attachments.page, ...rest.page].map((r) => r._id)).toEqual([
		ids.visible,
		ids.visible,
		ids.visible,
	])
	expect(JSON.stringify(rest)).not.toContain('PRIVATE-EVIDENCE')
	await f.t.run(async (ctx) => {
		const q = f.querying(f.context(ctx.db).ctx).payments
		expect(
			(
				await q
					.relation(rows.payments[1]._id, 'attachments')
					.paginate({ numItems: 100, cursor: null })
			).page,
		).toEqual([])
		// SAFETY: foreign parent brand is supplied only to test runtime normalization.
		await expect(
			q.relation(ids.visible as never, 'attachments').paginate({ numItems: 1, cursor: null }),
		).rejects.toThrow('INVALID_RELATION')
	})
	await f.t.run((ctx) => ctx.db.patch(rows.payments[0]._id, { allowed: false }))
	const revoked = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.payments.relation(rows.payments[0]._id, 'attachments')
			.paginate({ numItems: 100, cursor: first.page[0].attachments.continueCursor }),
	)
	expect(revoked.page).toEqual([])
})

test('ledger optional references return null for absent, hidden and nonapplicable targets', async () => {
	const f = variantFixture(),
		rows = await seedVariants(f)
	await f.t.run(async (ctx) => {
		await ctx.db.insert('ledger', { type: 'payment_entry', allowed: true })
		await ctx.db.insert('ledger', {
			type: 'payment_entry',
			paymentId: rows.payments[1]._id,
			creditorId: rows.creditor,
			allowed: true,
		})
		await ctx.db.insert('ledger', { type: 'adjustment', amountCents: 0, allowed: true })
		await ctx.db.insert('ledger', {
			type: 'payment_entry',
			paymentId: rows.payments[0]._id,
			allowed: true,
		})
		const page = await f
			.querying(f.context(ctx.db).ctx)
			.ledger.with({ payment: { client: true }, creditor: true })
			.paginate({ numItems: 100, cursor: null })
		expect(page.page.slice(0, 3).map((r) => r.payment)).toEqual([null, null, null])
		expect(page.page[0].creditor).toBeNull()
		expect(page.page[1].creditor?._id).toBe(rows.creditor)
		expect(page.page[3].payment?.client?._id).toBe(rows.client)
		expect(
			f.relations.tables.ledger.pageDto({ payment: { client: true }, creditor: true }).parse(page),
		).toEqual(page)
	})
})

test('unmanaged, default deny and finance denial preserve authorization despite readable clients', async () => {
	const f = variantFixture()
	await seedVariants(f)
	await f.t.run(async (ctx) => {
		expect(() => f.querying({ db: observed(ctx.db).raw })).toThrow('UNMANAGED_QUERY_CONTEXT')
		expect(
			(
				await f
					.querying(managed(ctx.db, {}, 'deny'))
					.payments.paginate({ numItems: 100, cursor: null })
			).page,
		).toEqual([])
		const q = f.querying(f.context(ctx.db, 'user', false).ctx)
		expect((await q.clients.paginate({ numItems: 100, cursor: null })).page).toHaveLength(1)
		expect((await q.payments.paginate({ numItems: 100, cursor: null })).page).toEqual([])
		expect(
			(await q.clients.with({ payments: true }).paginate({ numItems: 100, cursor: null })).page[0]
				.payments.page,
		).toEqual([])
	})
})

test('cursor replay rejects identity, branch, filter, selection, table and tampering before reads', async () => {
	const f = variantFixture(),
		rows = await seedVariants(f)
	const filters = {
		variant: { tag: 'creditor_payment', filters: { creditorId: rows.creditor } },
	} as const
	const first = await f.t.run((ctx) =>
		f.querying(f.context(ctx.db).ctx).payments.paginate({ numItems: 1, cursor: null, filters }),
	)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db),
			q = f.querying(o.ctx)
		for (const run of [
			() => q.payments.paginate({ numItems: 1, cursor: first.continueCursor + '00', filters }),
			() => q.payments.paginate({ numItems: 1, cursor: first.continueCursor }),
			() =>
				q.payments.paginate({
					numItems: 1,
					cursor: first.continueCursor,
					filters: { variant: { tag: 'client_draft', filters: {} } },
				}),
			() =>
				q.payments.paginate({
					numItems: 1,
					cursor: first.continueCursor,
					filters: { ...filters, amountCents: { gte: 7 } },
				}),
			() =>
				q.payments
					.with({ client: true })
					.paginate({ numItems: 1, cursor: first.continueCursor, filters }),
			() => q.clients.paginate({ numItems: 1, cursor: first.continueCursor }),
			() =>
				f
					.querying(f.context(o.raw, 'other').ctx)
					.payments.paginate({ numItems: 1, cursor: first.continueCursor, filters }),
		])
			await expect(run()).rejects.toThrow('Invalid cursor')
		expect(o.counts.next + o.counts.gets).toBe(0)
	})
	await f.t.run((ctx) => ctx.db.patch(rows.payments[5]._id, { allowed: false }))
	const next = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.payments.paginate({ numItems: 100, cursor: first.continueCursor, filters }),
	)
	expect(next.page.map((r) => r._id)).toEqual([rows.payments[7]._id])
})

test('draft stray creditor key cannot activate branch relation or issue creditor lookup', async () => {
	const f = variantFixture(),
		rows = await seedVariants(f)
	await f.t.run(async (ctx) => {
		const raw = corruptVariantRow(ctx.db, rows.payments[0]._id, { creditorId: rows.creditor })
		const o = f.context(raw)
		const result = await f
			.querying(o.ctx)
			.payments.with({ creditor: true })
			.paginate({ numItems: 1, cursor: null, filters: { _id: rows.payments[0]._id } })
		expect(result.page).toHaveLength(1)
		expect(result.page[0].creditor).toBeNull()
		expect(result.page[0]).not.toHaveProperty('creditorId')
		expect(o.counts.gets).toBe(0)
	})
})

test('wrong-table ledger reference normalizes before fetching any target', async () => {
	const f = variantFixture(),
		rows = await seedVariants(f)
	const id = await f.t.run((ctx) =>
		ctx.db.insert('ledger', { type: 'payment_entry', allowed: true }),
	)
	await f.t.run(async (ctx) => {
		const raw = corruptVariantRow(ctx.db, id, { paymentId: rows.client, creditorId: rows.client })
		const o = f.context(raw)
		const result = await f
			.querying(o.ctx)
			.ledger.with({ payment: true, creditor: true })
			.paginate({ numItems: 1, cursor: null })
		expect(result.page[0].payment).toBeNull()
		expect(result.page[0].creditor).toBeNull()
		expect(o.counts.gets).toBe(0)
	})
})

test('unknown tag and invalid required branch row fail closed without private evidence', async () => {
	const f = variantFixture(),
		rows = await seedVariants(f)
	for (const patch of [{ type: 'unknown' }, { draftDate: undefined }, { draftDate: -1 }]) {
		await f.t.run(async (ctx) => {
			const raw = corruptVariantRow(ctx.db, rows.payments[0]._id, patch)
			try {
				await f
					.querying(f.context(raw).ctx)
					.payments.with({ creditor: true })
					.paginate({ numItems: 1, cursor: null })
				throw new Error('unexpected malformed row acceptance')
			} catch (error) {
				expect(error).toBeInstanceOf(Error)
				expect(String(error)).not.toContain('unexpected malformed row acceptance')
				expect(String(error)).not.toContain('PRIVATE-EVIDENCE')
				expect(JSON.stringify(error)).not.toContain('PRIVATE-EVIDENCE')
			}
		})
	}
})

test.each([
	[
		'native validator',
		(f: ReturnType<typeof variantFixture>) =>
			Reflect.set(f.payments.table.validator, 'isOptional', 'optional'),
	],
	[
		'Zod branch',
		(f: ReturnType<typeof variantFixture>) =>
			Reflect.set(f.payments.schema.options[0].shape, 'draftDate', z.string()),
	],
	[
		'discriminator',
		(f: ReturnType<typeof variantFixture>) =>
			Reflect.set(f.payments.schema.options[0].shape, 'type', z.literal('creditor_payment')),
	],
	[
		'public DTO',
		(f: ReturnType<typeof variantFixture>) =>
			Reflect.set(f.payments.publicDto.options[0].shape, 'external', z.unknown()),
	],
	[
		'relation guard',
		(f: ReturnType<typeof variantFixture>) => {
			const leg = getRelationMetadata(f.relations).declarations.payments.creditor.from
			const ref = 'base' in leg ? leg.base : leg
			return Reflect.set(ref.guard!, 'tag', 'client_draft')
		},
	],
] as const)(
	'%s source mutation preserves continuations and captured registry contracts',
	async (_name, mutate) => {
		const f = variantFixture()
		await seedVariants(f)
		const first = await f.t.run((ctx) =>
			f.querying(f.context(ctx.db).ctx).payments.paginate({ numItems: 1, cursor: null }),
		)
		const output = f.relations.tables.payments.pageDto({})
		const input = f.relations.tables.payments.paginationOpts({ type: true })
		// Owned declarations reject edits; source schema edits leave the snapshot stable.
		if (!mutate(f)) return
		await f.t.run(async (ctx) => {
			const o = f.context(ctx.db)
			await expect(
				Promise.resolve().then(() =>
					f.querying(o.ctx).payments.paginate({ numItems: 1, cursor: first.continueCursor }),
				),
			).resolves.toMatchObject({ page: [expect.any(Object)] })
			expect(o.counts.next + o.counts.gets).toBeGreaterThan(0)
		})
		expect(output.safeParse({ page: [], isDone: true, continueCursor: '' }).success).toBe(true)
		expect(input.safeParse({ numItems: 1, cursor: null }).success).toBe(true)
	},
)

test('malicious branch scopes, wrong joins and incompatible common fields reject registration', () => {
	expect(() =>
		defineRelations(variantDeclarations(), (_r, branch) => {
			// SAFETY: attacker asks for a branch scope on an ordinary object table.
			branch('clients' as never, 'client_draft' as never)
			return {}
		}),
	).toThrow()
	for (const tag of ['unknown', 'client_draft']) {
		const tables = variantDeclarations()
		expect(() =>
			defineRelations(tables, (r, branch) => ({
				payments: {
					// SAFETY: attacker metadata supplies an unknown scope or an absent branch key.
					creditor: r.one.creditors({
						from: branch('payments', tag as never).creditorId,
						to: r.creditors._id,
					} as never) as never,
				},
			})),
		).toThrow()
	}
	const tables = variantDeclarations()
	expect(() =>
		defineRelations(tables, (r, branch) => ({
			payments: {
				// SAFETY: wrong-table target deliberately bypasses the join type contract.
				creditor: r.one.clients({
					from: branch('payments', 'creditor_payment').creditorId,
					to: r.clients._id,
				} as never) as never,
			},
		})),
	).toThrow()
	const mixed = zodVariantTable(
		'mixed',
		z.discriminatedUnion('type', [
			z.strictObject({ type: z.literal('a'), ref: zid('clients') }),
			z.strictObject({ type: z.literal('b'), ref: zid('creditors') }),
		]),
		{
			discriminator: 'type',
			variants: { a: { publicFields: ['ref'] }, b: { publicFields: ['ref'] } },
		},
	)
	expect(() =>
		defineRelations({ ...tables, mixed }, (r) => ({
			mixed: {
				// SAFETY: incompatible common key is runtime attacker input, not consumer API usage.
				client: r.one.clients({
					from: r.mixed['ref' as never],
					to: r.clients._id,
				} as never) as never,
			},
		})),
	).toThrow()
})

test('tagged partial update validates merged storage and requery without invalid writes', async () => {
	const f = variantFixture(),
		rows = await seedVariants(f)
	await f.t.run(async (ctx) => {
		const current = (await ctx.db.get(rows.payments[0]._id))!
		if (current.type !== 'client_draft') throw new Error('fixture branch mismatch')
		const patch = f.payments.updateSchema.parse({ type: 'client_draft', amountCents: 42 })
		const stored = Object.fromEntries(
			Object.entries(current).filter(([key]) => key !== '_id' && key !== '_creationTime'),
		)
		const merged = f.payments.storage.parse({ ...stored, ...patch })
		await ctx.db.replace(current._id, merged)
		const after = await ctx.db.get(current._id)
		expect(
			f.payments.updateSchema.safeParse({ type: 'client_draft', creditorId: rows.creditor })
				.success,
		).toBe(false)
		for (const raw of [
			{ type: 'creditor_payment', amountCents: 99 },
			{ type: 'client_draft', amountCents: -1 },
		]) {
			let writes = 0
			try {
				const change = f.payments.updateSchema.parse(raw)
				if (change.type !== current.type)
					throw new Error('tag conversion requires explicit application operation')
				const next = f.payments.storage.parse({ ...merged, ...change })
				await ctx.db.replace(current._id, next)
				writes++
			} catch {
				/* Application transaction aborts before persistence. */
			}
			expect(writes).toBe(0)
			expect(await ctx.db.get(current._id)).toEqual(after)
		}
		const result = await f
			.querying(f.context(ctx.db).ctx)
			.payments.paginate({ numItems: 1, cursor: null, filters: { _id: current._id } })
		expect(result.page[0].amountCents).toBe(42)
		expect(f.relations.tables.payments.pageDto({}).parse(result)).toEqual(result)
	})
})

test('mixed common index stays selective and immutable chains cannot override parent or server constraints', async () => {
	const f = variantFixture(),
		rows = await seedVariants(f)
	await f.t.run(async (ctx) => {
		const other = await ctx.db.insert('clients', { name: 'Other', allowed: true })
		for (let n = 0; n < 40; n++)
			await ctx.db.insert('payments', {
				type: 'client_draft',
				clientId: other,
				amountCents: n + 1,
				draftDate: n,
				allowed: true,
			})
		const o = f.context(ctx.db),
			q = f.querying(o.ctx).payments
		const all = await q.paginate({
			numItems: 100,
			cursor: null,
			filters: { clientId: rows.client },
		})
		expect(all.page.map((r) => r._id)).toEqual(
			rows.payments.filter((r) => r.allowed).map((r) => r._id),
		)
		expect(o.counts.returned).toBeLessThanOrEqual(8)
		const server = q.where({ clientId: rows.client })
		const narrowed = server.where({ type: 'creditor_payment' })
		expect((await server.paginate({ numItems: 100, cursor: null })).page).toHaveLength(6)
		expect(
			(await narrowed.paginate({ numItems: 100, cursor: null })).page.map((r) => r._id),
		).toEqual([3, 5, 7].map((n) => rows.payments[n]._id))
		expect(
			(await server.paginate({ numItems: 100, cursor: null, filters: { clientId: other } })).page,
		).toEqual([])
	})
})

test('attachment continuation rechecks revoked junction and target permissions', async () => {
	for (const gate of ['junction', 'target'] as const) {
		const f = variantFixture(),
			rows = await seedVariants(f)
		const created = await f.t.run(async (ctx) => {
			const target = await ctx.db.insert('attachments', {
				name: 'Attachment',
				allowed: true,
				evidence: 'PRIVATE-EVIDENCE',
			})
			const first = await ctx.db.insert('paymentAttachments', {
				paymentId: rows.payments[0]._id,
				attachmentId: target,
				allowed: true,
			})
			const second = await ctx.db.insert('paymentAttachments', {
				paymentId: rows.payments[0]._id,
				attachmentId: target,
				allowed: true,
			})
			return { target, first, second }
		})
		const first = await f.t.run((ctx) =>
			f
				.querying(f.context(ctx.db).ctx)
				.payments.relation(rows.payments[0]._id, 'attachments')
				.paginate({ numItems: 1, cursor: null }),
		)
		expect(first.page.map((r) => r._id)).toEqual([created.target])
		expect(first.isDone).toBe(false)
		await f.t.run(async (ctx) => {
			if (gate === 'target') await ctx.db.patch(created.target, { allowed: false })
			else await ctx.db.patch(created.second, { allowed: false })
		})
		const next = await f.t.run((ctx) =>
			f
				.querying(f.context(ctx.db).ctx)
				.payments.relation(rows.payments[0]._id, 'attachments')
				.paginate({ numItems: 10, cursor: first.continueCursor }),
		)
		expect(next.page).toEqual([])
		expect(JSON.stringify(next)).not.toContain('PRIVATE-EVIDENCE')
	}
})

test.each([false, true])(
	'generated variant contracts support scalar variants and single branch: %s',
	async (single) => {
		const a = z.strictObject({ type: z.literal('a'), variants: z.string(), value: z.number() })
		const b = z.strictObject({ type: z.literal('b'), variants: z.string(), label: z.string() })
		const records = zodVariantTable('records', z.discriminatedUnion('type', [a, b]), {
			discriminator: 'type',
			variants: {
				a: { publicFields: ['variants', 'value'] },
				b: { publicFields: ['variants', 'label'] },
			},
		})
		const singleRecords = zodVariantTable('records', z.discriminatedUnion('type', [a]), {
			discriminator: 'type',
			variants: { a: { publicFields: ['variants', 'value'] } },
		})
		const boundary = single ? singleRecords : records
		const relations = defineRelations({ records: boundary }, () => ({}))
		const schema = defineSchema({ records: boundary.table })
		const { createTest } = defineTestApp({ schema }).defineModules({})
		const querying = createQueryEngine({ schema, relations }, { cursor })
		const scalarInput = relations.tables.records.paginationOpts({ variants: true })
		const branchInput = relations.tables.records.paginationOpts({
			variants: { a: { value: true } },
		})
		await createTest().run(async (ctx) => {
			const expected = await ctx.db.insert('records', { type: 'a', variants: 'selected', value: 7 })
			await ctx.db.insert('records', { type: 'a', variants: 'other', value: 8 })
			for (const args of [
				scalarInput.parse({ numItems: 10, cursor: null, filters: { variants: 'selected' } }),
				branchInput.parse({
					numItems: 10,
					cursor: null,
					filters: { variant: { tag: 'a', filters: { value: 7 } } },
				}),
			]) {
				const result = await querying(
					managed<DataModelFromSchemaDefinition<typeof schema>>(ctx.db),
				).records.paginate(args)
				expect(result.page.map((row) => row._id)).toEqual([expected])
				expect(relations.tables.records.pageDto({}).parse(result)).toEqual(result)
			}
		})
	},
)
