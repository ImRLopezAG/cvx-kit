import { expect, test } from 'vite-plus/test'
import {
	idUnionFixture,
	idUnionRelations,
	seedIdUnions,
	members,
	taskFields,
	targetFields,
} from './fixture-querying/id-unions'

import { createPlanner } from '../src/querying/planner'
import { createQueryEngine } from '../src/querying'
import { defineRelations } from '../src/relations-public'
import { ManagedReadError, type SecurityPolicyContext } from '../src/querying/security'
import type { Rules } from '../src/tenancy'
import type { IdUnionDM } from './fixture-querying/id-unions'
import { ConvexError } from 'convex/values'
import { cursor, scope, managed } from './fixture-querying/scalar'

const selection = {
	referenceTask: true,
	lead: true,
	contact: true,
	client: true,
	creditor: true,
	deal: true,
	payment: true,
	postedPayment: true,
	ledgerEntry: true,
	debitEntry: true,
} as const
const names = [
	'referenceTask',
	'lead',
	'contact',
	'client',
	'creditor',
	'deal',
	'payment',
	'ledgerEntry',
] as const

test('all eight forward targets and inverses use the shared authorized engine and generated DTOs', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db),
			q = f.querying(o.ctx)
		const page = await q.tasks.with(selection).paginate({ numItems: 20, cursor: null })
		expect(f.relations.tables.tasks.pageDto(selection).parse(page)).toEqual(page)
		const inverseQueries = {
			tasks: () => q.tasks.relation(ids.targets.tasks, 'referencingTasks'),
			leads: () => q.leads.relation(ids.targets.leads, 'tasks'),
			contacts: () => q.contacts.relation(ids.targets.contacts, 'tasks'),
			clients: () => q.clients.relation(ids.targets.clients, 'tasks'),
			creditors: () => q.creditors.relation(ids.targets.creditors, 'tasks'),
			deals: () => q.deals.relation(ids.targets.deals, 'tasks'),
			payments: () => q.payments.relation(ids.targets.payments, 'tasks'),
			ledger: () => q.ledger.relation(ids.targets.ledger, 'tasks'),
		}
		for (const [i, member] of members.entries()) {
			const row = page.page.find((row) => row._id === ids.links[i])!
			expect(row.rel).toBe(ids.targets[member])
			for (const [j, name] of names.entries())
				expect(row[name]?._id ?? null).toBe(i === j ? ids.targets[member] : null)
			const inverse = await inverseQueries[member]().paginate({ numItems: 20, cursor: null })
			expect(inverse.page.map((row) => row._id)).toEqual([ids.links[i]])
		}
		expect(JSON.stringify(page)).not.toContain('SECRET')
		expect(o.counts.gets).toBeLessThanOrEqual(16)
	})
})

test('optional/null and wrong members are absent without fetching any target', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	await f.t.run(async (ctx) => {
		await ctx.db.insert('tasks', { ...taskFields, ordinal: 20, rel: null })
	})
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const result = await f
			.querying(o.ctx)
			.tasks.with({ referenceTask: true })
			.paginate({ numItems: 20, cursor: null, filters: { not: { rel: ids.targets.tasks } } })
		expect(result.page.every((row) => row.referenceTask === null)).toBe(true)
		expect(o.counts.gets).toBe(0)
	})
})

test('member guard prevents indexed union-to-union lookup on a nonmatching source', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const result = await f
			.querying(o.ctx)
			.tasks.with({ selected: true })
			.paginate({ numItems: 1, cursor: null, filters: { _id: ids.links[3] } })
		expect(result.page[0].selected).toBeNull()
		// Only the root page should read a range; no lookup of tasks linked to a client.
		expect(o.counts.ranges).toBe(1)
		// SAFETY: hostile parent ID deliberately bypasses the branded API.
		const page = await f
			.querying(o.ctx)
			.tasks.relation(ids.targets.clients as never, 'referencingTasks')
			.paginate({ numItems: 1, cursor: null })
			.catch((error) => error)
		expect(page).toBeInstanceOf(Error)
	})
})

test.each(['hydration', 'child'] as const)(
	'source-only member guard avoids a singleton foreign-key index in %s',
	async (mode) => {
		const f = idUnionFixture(),
			ids = await seedIdUnions(f)
		f.tables.deals.table.index('by_clientId', ['clientId'])
		const relations = defineRelations(f.tables, (r) => ({
			tasks: {
				clientDeals: r.many.deals({
					from: r.tasks.rel.forTable('clients'),
					to: r.deals.clientId,
				}),
			},
		}))
		const querying = createQueryEngine({ schema: f.schema, relations }, { cursor })
		await f.t.run(async (ctx) => {
			const o = f.context(ctx.db)
			const page = await querying(o.ctx)
				.tasks.with({ clientDeals: true })
				.paginate({
					numItems: 1,
					cursor: null,
					filters: { _id: ids.links[3] },
				})
			expect(page.page[0].clientDeals.page.map((row) => row._id)).toEqual([ids.targets.deals])
			expect(o.counts.ranges).toBe(2)
		})
		if (mode === 'hydration')
			await f.t.run(async (ctx) => {
				const o = f.context(ctx.db)
				const page = await querying(o.ctx)
					.tasks.with({ clientDeals: true })
					.paginate({
						numItems: 1,
						cursor: null,
						filters: { _id: ids.links[0] },
					})
				expect(page.page[0].clientDeals.page).toEqual([])
				expect(page.page[0].clientDeals.isDone).toBe(true)
				expect(o.counts.ranges).toBe(1)
			})
		else
			await f.t.run(async (ctx) => {
				const o = f.context(ctx.db)
				const page = await querying(o.ctx)
					.tasks.relation(ids.links[0], 'clientDeals')
					.paginate({ numItems: 1, cursor: null })
				expect(page.page).toEqual([])
				expect(page.isDone).toBe(true)
				expect(o.counts.gets).toBe(1)
				expect(o.counts.ranges).toBe(0)
			})
	},
)

test('union target guards and variant discriminator guards compose independently in both directions', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	const extra = await f.t.run(async (ctx) => {
		const payment = await ctx.db.insert('payments', {
			...targetFields,
			type: 'draft',
			clientId: ids.targets.clients,
			memo: 'draft',
		})
		const ledger = await ctx.db.insert('ledger', {
			...targetFields,
			type: 'credit',
			clientId: ids.targets.clients,
			reason: 'credit',
		})
		const draft = await ctx.db.insert('tasks', { ...taskFields, ordinal: 30, rel: payment })
		const credit = await ctx.db.insert('tasks', { ...taskFields, ordinal: 31, rel: ledger })
		return { payment, ledger, draft, credit }
	})
	await f.t.run(async (ctx) => {
		const q = f.querying(f.context(ctx.db).ctx)
		const page = await q.tasks.with(selection).paginate({ numItems: 30, cursor: null })
		const draft = page.page.find((row) => row._id === extra.draft)!,
			credit = page.page.find((row) => row._id === extra.credit)!
		expect(draft.payment).toMatchObject({ _id: extra.payment, type: 'draft', memo: 'draft' })
		expect(draft.postedPayment).toBeNull()
		expect(credit.ledgerEntry).toMatchObject({
			_id: extra.ledger,
			type: 'credit',
			reason: 'credit',
		})
		expect(credit.debitEntry).toBeNull()
		expect(
			(
				await q.payments.relation(extra.payment, 'tasks').paginate({ numItems: 10, cursor: null })
			).page.map((row) => row._id),
		).toEqual([extra.draft])
		expect(
			(
				await q.payments
					.relation(extra.payment, 'postedTasks')
					.paginate({ numItems: 10, cursor: null })
			).page,
		).toEqual([])
		expect(
			(
				await q.tasks.paginate({
					numItems: 30,
					cursor: null,
					filters: { payment: { variant: { tag: 'draft', filters: { memo: 'draft' } } } },
				})
			).page.map((row) => row._id),
		).toEqual([extra.draft])
	})
})

test('indexed inverse pages fill after authorization and nested filters, continue in both orders and relink/clear', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	const linked = await f.t.run(async (ctx) => {
		const rows = []
		for (let ordinal = 10; ordinal < 18; ordinal++)
			rows.push(
				await ctx.db.insert('tasks', {
					...taskFields,
					ordinal,
					rel: ids.targets.clients,
					allowed: ordinal !== 10,
					status: ordinal % 2 ? 'open' : 'done',
				}),
			)
		await ctx.db.insert('tasks', { ...taskFields, ordinal: 19, rel: ids.targets.leads })
		return rows
	})
	for (const order of ['asc', 'desc'] as const) {
		const expected = linked.filter((_, i) => i % 2 === 1)
		if (order === 'desc') expected.reverse()
		const actual: string[] = []
		let token: string | null = null
		for (let n = 0; n < 5; n++) {
			const page = await f.t.run((ctx) =>
				f
					.querying(f.context(ctx.db).ctx)
					.clients.relation(ids.targets.clients, 'tasks')
					.paginate({
						numItems: n % 2 ? 2 : 1,
						cursor: token,
						order,
						filters: { and: [{ ordinal: { gte: 10 } }, { status: 'open', referenceTask: null }] },
					}),
			)
			actual.push(...page.page.map((row) => row._id))
			if (page.isDone) break
			expect(page.continueCursor).not.toBe(token)
			token = page.continueCursor
			expect(n).toBeLessThan(4)
		}
		expect(actual).toEqual(expected)
	}
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const inverse = await f
			.querying(o.ctx)
			.clients.relation(ids.targets.clients, 'tasks')
			.paginate({ numItems: 30, cursor: null })
		expect(inverse.page.map((row) => row._id)).toEqual([ids.links[3], ...linked.slice(1)])
		// The native index equality must exclude every unrelated task candidate.
		expect(o.counts.returned).toBe(9) // only nine matching raw children; parent is a metered get
		expect(o.counts.gets).toBe(1)
		expect(o.counts.ranges).toBe(1)
		await ctx.db.patch(linked[1], { rel: ids.targets.leads })
		await ctx.db.patch(linked[3], { rel: null })
	})
	await f.t.run(async (ctx) => {
		const q = f.querying(f.context(ctx.db).ctx)
		const clients = await q.clients
			.relation(ids.targets.clients, 'tasks')
			.paginate({ numItems: 30, cursor: null })
		expect(clients.page.map((row) => row._id)).toEqual([
			ids.links[3],
			...linked.slice(1).filter((id) => id !== linked[1] && id !== linked[3]),
		])
		expect(
			(
				await q.leads.relation(ids.targets.leads, 'tasks').paginate({ numItems: 30, cursor: null })
			).page.map((row) => row._id),
		).toContain(linked[1])
		const cleared = await q.tasks
			.with({ client: true, lead: true })
			.paginate({ numItems: 1, cursor: null, filters: { _id: linked[3] } })
		expect(cleared.page[0]).toMatchObject({ rel: null, client: null, lead: null })
	})
})

test('source/target department denials and missing/deleted rows use authorized absence in null/logical filters', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	const extra = await f.t.run(async (ctx) => {
		const denied = await ctx.db.insert('clients', { ...targetFields, allowed: false })
		const otherDepartment = await ctx.db.insert('clients', { ...targetFields, department: 'b' })
		const deleted = await ctx.db.insert('clients', targetFields)
		await ctx.db.delete(deleted)
		const links = []
		for (const [ordinal, rel] of [denied, otherDepartment, deleted, null].entries())
			links.push(await ctx.db.insert('tasks', { ...taskFields, ordinal: 50 + ordinal, rel }))
		const hiddenSource = await ctx.db.insert('tasks', {
			...taskFields,
			ordinal: 99,
			rel: ids.targets.clients,
			allowed: false,
		})
		return { links, hiddenSource }
	})
	await f.t.run(async (ctx) => {
		const q = f.querying(f.context(ctx.db).ctx).tasks
		const page = await q.with({ client: true }).paginate({ numItems: 30, cursor: null })
		expect(page.page.find((row) => row._id === extra.hiddenSource)).toBeUndefined()
		for (const id of extra.links) expect(page.page.find((row) => row._id === id)!.client).toBeNull()
		const matching = await q.paginate({
			numItems: 30,
			cursor: null,
			filters: {
				and: [
					{ ordinal: { gte: 1 } },
					{ not: { client: null } },
					{ or: [{ client: { name: 'Public' } }, { status: 'missing' }] },
				],
			},
		})
		expect(matching.page.map((row) => row._id)).toEqual([ids.links[3]])
		const absent = await q.paginate({
			numItems: 30,
			cursor: null,
			filters: { ordinal: { gte: 50 }, client: null },
		})
		expect(absent.page.map((row) => row._id)).toEqual(extra.links)
		expect(JSON.stringify(page)).not.toContain('SECRET')
	})
})

test('some/none truth tables use authorized selected members and nested status filters', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	const extra = await f.t.run(async (ctx) => {
		const empty = await ctx.db.insert('clients', { ...targetFields, name: 'Empty' })
		const onlyDenied = await ctx.db.insert('clients', { ...targetFields, name: 'Denied children' })
		const onlyDone = await ctx.db.insert('clients', { ...targetFields, name: 'Done' })
		await ctx.db.insert('tasks', { ...taskFields, rel: onlyDenied, allowed: false })
		await ctx.db.insert('tasks', { ...taskFields, rel: onlyDone, status: 'done' })
		return { empty, onlyDenied, onlyDone }
	})
	await f.t.run(async (ctx) => {
		const q = f.querying(f.context(ctx.db).ctx).clients
		const some = await q.paginate({
			numItems: 20,
			cursor: null,
			filters: { tasks: { some: { status: 'open', client: { name: 'Public' } } } },
		})
		expect(some.page.map((row) => row._id)).toEqual([ids.targets.clients])
		const none = await q.paginate({
			numItems: 20,
			cursor: null,
			filters: { and: [{ not: { name: 'Public' } }, { tasks: { none: { status: 'open' } } }] },
		})
		expect(none.page.map((row) => row._id)).toEqual([extra.empty, extra.onlyDenied, extra.onlyDone])
		const all = await q.paginate({
			numItems: 20,
			cursor: null,
			filters: {
				or: [{ tasks: { some: { status: 'open' } } }, { tasks: { none: { status: 'open' } } }],
			},
		})
		expect(all.page.map((row) => row._id)).toEqual([
			ids.targets.clients,
			extra.empty,
			extra.onlyDenied,
			extra.onlyDone,
		])
	})
})

test('finance/domain policies may require currently authorized clients and share the read budget', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	await f.t.run((ctx) => ctx.db.patch(ids.targets.clients, { allowed: false }))
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db, scope, {
			deals: {
				read: async ({ db }, row) => row.allowed && !!(await db.get('clients', row.clientId)),
			},
			payments: {
				read: async ({ db }, row) => row.allowed && !!(await db.get('clients', row.clientId)),
			},
			ledger: {
				read: async ({ db }, row) => row.allowed && !!(await db.get('clients', row.clientId)),
			},
		})
		const page = await f
			.querying(o.ctx)
			.tasks.with({ deal: true, payment: true, ledgerEntry: true })
			.paginate({ numItems: 20, cursor: null })
		expect(
			page.page.every(
				(row) => row.deal === null && row.payment === null && row.ledgerEntry === null,
			),
		).toBe(true)
		expect(o.counts.gets).toBe(4) // three selected targets, one request-local denied client
		const parent = await f
			.querying(o.ctx)
			.payments.relation(ids.targets.payments, 'tasks')
			.paginate({ numItems: 20, cursor: null })
		expect(parent.page).toEqual([])
	})
})

test('a finance policy dependency consumes the selected relation read budget', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	const rules: Rules<SecurityPolicyContext<IdUnionDM>, IdUnionDM> = {
		payments: {
			read: async ({ db }, row) => row.allowed && !!(await db.get('clients', row.clientId)),
		},
	}
	const input = { numItems: 1, cursor: null } as const
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db, scope, rules)
		const page = await f
			.querying(o.ctx)
			.payments.relation(ids.targets.payments, 'tasks')
			.paginate(input)
		expect(page.page.map((row) => row._id)).toEqual([ids.links[6]])
		expect(o.counts.gets).toBe(2)
	})
	const querying = createQueryEngine(
		{ schema: f.schema, relations: f.relations },
		{
			cursor,
			budgets: { readOperations: 1 },
		},
	)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db, scope, rules)
		await expect(
			querying(o.ctx).payments.relation(ids.targets.payments, 'tasks').paginate(input),
		).rejects.toMatchObject({ name: 'ManagedReadError', code: 'MANAGED_READ_BUDGET' })
		expect(o.counts.gets).toBe(1)
		expect(o.counts.closes).toBe(o.counts.ranges)
	})
})

test.each([
	{ readOperations: 2 },
	{ rawCandidates: 2 },
	{ indexRanges: 1 },
	{ fanout: 1 },
	{ memoEntries: 1 },
])('incomplete none and hydration retain typed shared budget faults: %j', async (budgets) => {
	const f = idUnionFixture(budgets),
		ids = await seedIdUnions(f)
	await f.t.run(async (ctx) => {
		await ctx.db.insert('tasks', { ...taskFields, rel: ids.targets.clients, allowed: false })
		await ctx.db.insert('tasks', { ...taskFields, rel: ids.targets.clients })
	})
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		if ('memoEntries' in budgets) {
			await expect(
				f
					.querying(o.ctx)
					.tasks.with({ client: true, lead: true })
					.paginate({ numItems: 20, cursor: null }),
			).rejects.toMatchObject({ name: 'ManagedReadError', code: 'MANAGED_READ_BUDGET' })
		} else
			await expect(
				f.querying(o.ctx).clients.paginate({
					numItems: 1,
					cursor: null,
					filters: { _id: ids.targets.clients, tasks: { none: { ordinal: 999 } } },
				}),
			).rejects.toMatchObject({ name: 'ManagedReadError', code: 'MANAGED_READ_BUDGET' })
		expect(o.counts.closes).toBe(o.counts.ranges)
	})
})

test.each(['policy', 'database', 'typed'] as const)(
	'selected target %s faults retain existing redaction/error channel',
	async (kind) => {
		const f = idUnionFixture(),
			ids = await seedIdUnions(f)
		await f.t.run(async (ctx) => {
			const o = f.context(ctx.db, scope, {
				clients: {
					read: async () => {
						throw kind === 'typed'
							? new ManagedReadError('POLICY_RECURSION')
							: new ConvexError({ secret: 'POLICY SECRET' })
					},
				},
			})
			const raw =
				kind === 'database'
					? {
							...o.raw,
							get: async (...args: Parameters<typeof o.raw.get>) => {
								if (args[0] === 'clients') throw new Error('DATABASE SECRET')
								return o.raw.get(...args)
							},
						}
					: o.raw
			const query = f
				.querying(kind === 'database' ? managed(raw) : o.ctx)
				.tasks.with({ client: true })
			const error = await query
				.paginate({ numItems: 1, cursor: null, filters: { _id: ids.links[3] } })
				.catch((error: Error) => error)
			if (kind === 'typed')
				expect(error).toMatchObject({ name: 'ManagedReadError', code: 'POLICY_RECURSION' })
			else expect(error).toMatchObject({ message: 'Query execution failed' })
			expect(JSON.stringify(error)).not.toContain('SECRET')
		})
	},
)

test('root/nested child continuation reauthorizes current targets, parents and tasks', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	const children = await f.t.run(async (ctx) => {
		const rows = []
		for (let ordinal = 100; ordinal < 104; ordinal++)
			rows.push(await ctx.db.insert('tasks', { ...taskFields, ordinal, rel: ids.targets.clients }))
		return rows
	})
	const root = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.tasks.with({ client: { tasks: true } })
			.paginate({ numItems: 1, cursor: null, filters: { _id: ids.links[3] } }),
	)
	const nested = root.page[0].client!.tasks
	expect(nested.page.map((row) => row._id)).toEqual([ids.links[3]])
	const next = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.tasks.relation(ids.links[3], 'client.tasks')
			.paginate({ numItems: 2, cursor: nested.continueCursor }),
	)
	expect(next.page.map((row) => row._id)).toEqual(children.slice(0, 2))
	await f.t.run(async (ctx) => {
		await ctx.db.patch(children[2], { allowed: false })
		await ctx.db.patch(children[3], { department: 'b' })
	})
	const revokedChildren = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.tasks.relation(ids.links[3], 'client.tasks')
			.paginate({ numItems: 10, cursor: next.continueCursor }),
	)
	expect(revokedChildren.page).toEqual([])
	expect(revokedChildren.isDone).toBe(true)
	await f.t.run((ctx) => ctx.db.patch(ids.targets.clients, { allowed: false }))
	const revokedParent = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.tasks.relation(ids.links[3], 'client.tasks')
			.paginate({ numItems: 10, cursor: nested.continueCursor }),
	)
	expect(revokedParent.page).toEqual([])
	await f.t.run(async (ctx) => {
		await ctx.db.patch(ids.targets.clients, { allowed: true })
		await ctx.db.patch(ids.links[3], { allowed: false })
	})
	const revokedSource = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.tasks.relation(ids.links[3], 'client.tasks')
			.paginate({ numItems: 10, cursor: nested.continueCursor }),
	)
	expect(revokedSource.page).toEqual([])
})

test.each(['relink', 'clear', 'delete', 'deny-root', 'deny-ancestor'] as const)(
	'deep selected ancestry cannot regain descendants after %s',
	async (change) => {
		const f = idUnionFixture(),
			ids = await seedIdUnions(f)
		const chain = await f.t.run(async (ctx) => {
			const middle = await ctx.db.insert('tasks', { ...taskFields, rel: ids.targets.clients })
			const root = await ctx.db.insert('tasks', { ...taskFields, rel: middle })
			const other = await ctx.db.insert('tasks', taskFields)
			for (let i = 0; i < 3; i++)
				await ctx.db.insert('tasks', { ...taskFields, ordinal: 200 + i, rel: ids.targets.clients })
			return { root, middle, other }
		})
		const page = await f.t.run((ctx) =>
			f
				.querying(f.context(ctx.db).ctx)
				.tasks.with({ referenceTask: { client: { tasks: true } } })
				.paginate({ numItems: 1, cursor: null, filters: { _id: chain.root } }),
		)
		const token = page.page[0].referenceTask!.client!.tasks.continueCursor
		const baseline = await f.t.run((ctx) =>
			f
				.querying(f.context(ctx.db).ctx)
				.tasks.relation(chain.root, 'referenceTask.client.tasks')
				.paginate({ numItems: 20, cursor: token }),
		)
		expect(baseline.page.length).toBe(4)
		await f.t.run(async (ctx) => {
			if (change === 'relink') await ctx.db.patch(chain.root, { rel: chain.other })
			if (change === 'clear') await ctx.db.patch(chain.middle, { rel: null })
			if (change === 'delete') await ctx.db.delete(chain.middle)
			if (change === 'deny-root') await ctx.db.patch(chain.root, { allowed: false })
			if (change === 'deny-ancestor') await ctx.db.patch(chain.middle, { allowed: false })
		})
		const denied = await f.t.run((ctx) =>
			f
				.querying(f.context(ctx.db).ctx)
				.tasks.relation(chain.root, 'referenceTask.client.tasks')
				.paginate({ numItems: 20, cursor: token }),
		)
		expect(denied.page).toEqual([])
		expect(denied.isDone).toBe(true)
	},
)

test('child cursors bind actor/scope/member/declaration/parent/path/filter/order/selection/index and reject before reads', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	await f.t.run(async (ctx) => {
		for (let ordinal = 100; ordinal < 103; ordinal++)
			await ctx.db.insert('tasks', { ...taskFields, ordinal, rel: ids.targets.clients })
	})
	const first = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.clients.relation(ids.targets.clients, 'tasks')
			.paginate({ numItems: 1, cursor: null, filters: { status: 'open' } }),
	)
	const token = first.continueCursor
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db),
			q = f.querying(o.ctx)
		const args = { numItems: 1, cursor: token, filters: { status: 'open' } } as const
		const otherClient = await ctx.db.insert('clients', targetFields)
		const changedRelations = idUnionRelations(f.tables, 'clients')
		const changed = createQueryEngine({ schema: f.schema, relations: changedRelations }, { cursor })
		const changedPolicy = createQueryEngine(
			{ schema: f.schema, relations: f.relations },
			{ cursor, policyVersion: 'next' },
		)
		const changedEngine = createQueryEngine(
			{ schema: f.schema, relations: f.relations },
			{ cursor, engineVersion: 'next' },
		)
		const retiredKey = createQueryEngine(
			{ schema: f.schema, relations: f.relations },
			{ cursor: { version: 'v1', currentKeyId: 'new', keys: { new: new Uint8Array(64).fill(9) } } },
		)
		const attempts = [
			() => q.clients.relation(otherClient, 'tasks').paginate(args),
			() => q.leads.relation(ids.targets.leads, 'tasks').paginate(args),
			() => q.tasks.relation(ids.targets.tasks, 'referencingTasks').paginate(args),
			() => q.clients.relation(ids.targets.clients, 'tasks').paginate({ ...args, order: 'desc' }),
			() =>
				q.clients
					.relation(ids.targets.clients, 'tasks')
					.paginate({ ...args, filters: { status: 'done' } }),
			() => q.clients.relation(ids.targets.clients, 'tasks').with({ client: true }).paginate(args),
			() => q.clients.relation(ids.targets.clients, 'tasks').when(true, 'by_rel').paginate(args),
			() => q.clients.paginate({ ...args, filters: {} }),
			() => q.tasks.paginate(args),
			() => changedPolicy(o.ctx).clients.relation(ids.targets.clients, 'tasks').paginate(args),
			() => changedEngine(o.ctx).clients.relation(ids.targets.clients, 'tasks').paginate(args),
			() => retiredKey(o.ctx).clients.relation(ids.targets.clients, 'tasks').paginate(args),
			() =>
				q.clients
					.relation(ids.targets.clients, 'tasks')
					.paginate({ ...args, cursor: token.slice(0, -1) + (token.endsWith('0') ? '1' : '0') }),
			() =>
				q.clients.relation(ids.targets.clients, 'tasks').paginate({ ...args, cursor: 'malformed' }),
		]
		for (const call of attempts) await expect(call()).rejects.toThrow('Invalid cursor')
		expect(o.counts.gets + o.counts.next + o.counts.ranges).toBe(0)
		// Cursors bind only what their query reads. The changed registry differs in
		// tasks.selected* member metadata, which clients.tasks never walks...
		await expect(
			changed(o.ctx).clients.relation(ids.targets.clients, 'tasks').paginate(args),
		).resolves.toMatchObject({ isDone: false })
		// ...while any query that walks the changed edge binds a different version.
		const version = (relations: typeof f.relations, path: string[]) =>
			createPlanner(f.schema, relations).registryVersion({
				root: 'tasks',
				path,
				selection: {},
				groups: { relations: {} },
				filters: [],
			})
		for (const path of [['selected'], ['selectedTasks']])
			expect(await version(changedRelations, path)).not.toBe(await version(f.relations, path))
		expect(await version(changedRelations, ['client'])).toBe(await version(f.relations, ['client']))
		for (const authority of [
			{ ...scope, principal: 'other' },
			{ ...scope, organization: 'other' },
			{ ...scope, tenant: 'other' },
			{ ...scope, role: 'other' },
			{ ...scope, mode: 'trusted' as const },
		]) {
			const other = f.context(ctx.db, authority)
			await expect(
				f.querying(other.ctx).clients.relation(ids.targets.clients, 'tasks').paginate(args),
			).rejects.toThrow('Invalid cursor')
			expect(other.counts.gets + other.counts.next + other.counts.ranges).toBe(0)
		}
	})
})

test('unchanged registry is deterministic across construction and child page size changes', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	await f.t.run(async (ctx) => {
		for (let ordinal = 100; ordinal < 103; ordinal++)
			await ctx.db.insert('tasks', { ...taskFields, ordinal, rel: ids.targets.clients })
	})
	const first = await f.t.run((ctx) =>
		f
			.querying(f.context(ctx.db).ctx)
			.clients.relation(ids.targets.clients, 'tasks')
			.paginate({ numItems: 1, cursor: null }),
	)
	const identical = idUnionRelations(f.tables)
	expect(identical.identity).toBe(f.relations.identity)
	const query = createQueryEngine({ schema: f.schema, relations: identical }, { cursor })
	const next = await f.t.run((ctx) =>
		query(f.context(ctx.db).ctx)
			.clients.relation(ids.targets.clients, 'tasks')
			.paginate({ numItems: 10, cursor: first.continueCursor }),
	)
	expect(next.page.length).toBe(3)
	expect(next.isDone).toBe(true)
})

test('pageRelation applies the member guard before a source-union index lookup', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const page = await f
			.querying(o.ctx)
			.tasks.relation(ids.links[3], 'selectedTasks')
			.paginate({ numItems: 10, cursor: null })
		expect(page.page).toEqual([])
		expect(page.isDone).toBe(true)
		expect(o.counts.gets).toBe(1)
		expect(o.counts.next + o.counts.ranges).toBe(0)
	})
})

test('request-local selected lookup memoization preserves many-to-one sharing and fresh authority', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	const extra = await f.t.run(async (ctx) => {
		const rows = []
		for (let ordinal = 100; ordinal < 120; ordinal++)
			rows.push(await ctx.db.insert('tasks', { ...taskFields, ordinal, rel: ids.targets.clients }))
		return rows
	})
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const page = await f
			.querying(o.ctx)
			.tasks.with({
				client: true,
				referenceTask: true,
				lead: true,
				payment: true,
				ledgerEntry: true,
			})
			.paginate({ numItems: 30, cursor: null, filters: { ordinal: { gte: 100 } } })
		expect(page.page.map((row) => row._id)).toEqual(extra)
		expect(
			page.page.every(
				(row) =>
					row.client?._id === ids.targets.clients &&
					row.referenceTask === null &&
					row.lead === null &&
					row.payment === null &&
					row.ledgerEntry === null,
			),
		).toBe(true)
		expect(o.counts.gets).toBe(1)
		expect(o.counts.ranges).toBe(1)
	})
	await f.t.run((ctx) => ctx.db.patch(ids.targets.clients, { allowed: false }))
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db)
		const page = await f
			.querying(o.ctx)
			.tasks.with({ client: true })
			.paginate({ numItems: 30, cursor: null, filters: { ordinal: { gte: 100 } } })
		expect(page.page.every((row) => row.client === null)).toBe(true)
		expect(o.counts.gets).toBe(1)
	})
})

test('native public generated page validators run root hydration and inverse child continuation', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	const children = await f.t.run(async (ctx) => {
		const children = []
		for (let ordinal = 100; ordinal < 103; ordinal++)
			children.push(
				await ctx.db.insert('tasks', { ...taskFields, ordinal, rel: ids.targets.clients }),
			)
		return children
	})
	const page = await f.t.query(f.api.functions.page, {
		input: { numItems: 1, cursor: null, filters: { ordinal: 4 } },
	})
	expect(page.page[0].client!.tasks.page.map((row) => row._id)).toEqual([ids.links[3]])
	await expect(
		f.t.query(f.api.functions.nextClients, {
			parent: ids.targets.clients,
			input: { numItems: 10, cursor: page.page[0].client!.tasks.continueCursor },
		}),
	).rejects.toThrow('Invalid cursor')
	const next = await f.t.query(f.api.functions.nextTasks, {
		parent: ids.links[3],
		input: { numItems: 10, cursor: page.page[0].client!.tasks.continueCursor },
	})
	expect(next.page.map((row) => row._id)).toEqual(children)
	expect(next.isDone).toBe(true)
	const direct = await f.t.query(f.api.functions.nextClients, {
		parent: ids.targets.clients,
		input: { numItems: 1, cursor: null },
	})
	const continued = await f.t.query(f.api.functions.nextClients, {
		parent: ids.targets.clients,
		input: { numItems: 10, cursor: direct.continueCursor },
	})
	expect([...direct.page, ...continued.page].map((row) => row._id)).toEqual([
		ids.links[3],
		...children,
	])
	await expect(
		f.t.query(f.api.functions.nextClients, {
			// @ts-expect-error public native parent validator rejects another allowed union table
			parent: ids.targets.tasks,
			input: { numItems: 1, cursor: null },
		}),
	).rejects.toThrow()
})

test.each(['wrong-member', 'null', 'undefined'] as const)(
	'target member is checked after async policy before predicates and page acceptance: %s',
	async (altered) => {
		const f = idUnionFixture(),
			ids = await seedIdUnions(f)
		await f.t.run(async (ctx) => {
			let calls = 0
			const rules: Rules<SecurityPolicyContext<IdUnionDM>, IdUnionDM> = {
				tasks: {
					read: async (_, row) => {
						await Promise.resolve()
						calls++
						// Fault injection at the awaited policy boundary: the index candidate had a matching native link.
						row.rel =
							altered === 'wrong-member' ? ids.targets.tasks : altered === 'null' ? null : undefined
						return true
					},
				},
			}
			const o = f.context(ctx.db, scope, rules),
				q = f.querying(o.ctx).clients
			const some = await q.paginate({
				numItems: 20,
				cursor: null,
				filters: { tasks: { some: {} } },
			})
			expect.soft(some.page).toEqual([])
			const direct = await q
				.relation(ids.targets.clients, 'tasks')
				.paginate({ numItems: 20, cursor: null })
			expect(direct.page).toEqual([])
			expect(direct.isDone).toBe(true)
			expect(calls).toBe(2)
		})
	},
)

test('selected inverse split/end cursors retain boundaries and authenticate both slots', async () => {
	const f = idUnionFixture(),
		ids = await seedIdUnions(f)
	await f.t.run(async (ctx) => {
		for (let ordinal = 100; ordinal < 108; ordinal++)
			await ctx.db.insert('tasks', { ...taskFields, ordinal, rel: ids.targets.clients })
	})
	await f.t.run(async (ctx) => {
		const o = f.context(ctx.db),
			q = f.querying(o.ctx).clients.relation(ids.targets.clients, 'tasks')
		const page = await q.paginate({ numItems: 30, cursor: null, maximumRowsRead: 5 })
		expect(page.splitCursor).toMatch(/^pc\./)
		const left = await q.paginate({ numItems: 30, cursor: null, endCursor: page.splitCursor })
		const right = await q.paginate({
			numItems: 30,
			cursor: page.splitCursor!,
			endCursor: page.continueCursor,
		})
		expect([...left.page, ...right.page]).toEqual(page.page)
		const before = { ...o.counts }
		await expect(
			q.paginate({ numItems: 30, cursor: page.splitCursor!, endCursor: 'malformed' }),
		).rejects.toThrow('Invalid cursor')
		await expect(
			f
				.querying(o.ctx)
				.leads.relation(ids.targets.leads, 'tasks')
				.paginate({ numItems: 30, cursor: null, endCursor: page.continueCursor }),
		).rejects.toThrow('Invalid cursor')
		expect(o.counts).toEqual(before)
	})
})
