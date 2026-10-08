import { Context, Effect } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'
import { z } from 'zod'
import { convexTest } from 'convex-test'
import {
	actionGeneric,
	defineSchema,
	defineTable,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	makeFunctionReference,
	mutationGeneric,
	queryGeneric,
	type DataModelFromSchemaDefinition,
	type GenericDatabaseReader,
	type GenericDatabaseWriter,
} from 'convex/server'
import { v } from 'convex/values'
import { createAuthFunctions } from '../src/auth'
import { createTriggers } from '../src/triggers'
import { effectZodApiBuilder } from '../src/effect'
import { createEffectCrud, type EffectCrudPagination } from '../src/modules/effect/crud'
import { createEffectFoundation } from '../src/effect'
import { paginated, tenantTable, zodTable } from '../src/zod-table'

const table = tenantTable('notes', () => ({ text: z.string(), secret: z.string() }), {
	commandFields: ['text'],
	publicFields: ['text'],
})
type Row = z.input<typeof table.storage>
type Id = z.output<typeof table.tools.id>['id']
type Host = { tenant: string; actor: string }
function harness() {
	const rows = new Map<Id, Row>()
	const audits: string[] = []
	const guards: string[] = []
	let resolved = 0
	let serial = 0
	const foundation = createEffectFoundation({
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
		},
		writeAudit: (_host: Host, entry) => {
			audits.push(entry.operation)
		},
		checkPermission: (host: Host) => {
			if (host.actor === 'denied') throw Error('DENIED')
		},
	})
	const context = (host: Host) => {
		resolved++
		return {
			...host,
			db: {
				insert: async (_name: string, values: Row) => {
					const id = table.tools.id.parse({ id: `id_${++serial}` }).id
					rows.set(id, values)
					return id
				},
				patch: async (id: Id, values: Partial<Row>) => {
					const row = rows.get(id)
					if (!row || row.tenant !== host.tenant) throw Error('MISSING_OR_DENIED')
					rows.set(id, { ...row, ...values })
				},
			},
		}
	}
	const config = {
		foundation,
		table,
		context,
		aggregateType: 'note',
		checkId: (_ctx: ReturnType<typeof context>, id: string) =>
			/^id_[0-9]+$/.test(id) || id === 'missing',
		actor: (ctx: ReturnType<typeof context>) => ctx.actor,
		enrich: (ctx: ReturnType<typeof context>) => ({
			tenant: ctx.tenant,
			secret: 'server',
			text: 'enriched',
		}),
		policy: {
			guard: (ctx: ReturnType<typeof context>) => {
				guards.push(ctx.actor)
			},
			permissions: { archive: 'archive' },
		},
		read: {
			maxPageSize: 2,
			project: (row: Row) => ({ text: row.text }),
			get: (ctx: ReturnType<typeof context>, id: Id) => {
				const row = rows.get(id)
				return row?.tenant === ctx.tenant ? row : null
			},
			list: (
				ctx: ReturnType<typeof context>,
				opts: { numItems: number; cursor: string | null },
			) => {
				const visible = [...rows.values()].filter((row) => row.tenant === ctx.tenant)
				return { page: visible.slice(0, opts.numItems), isDone: true, continueCursor: '' }
			},
		},
	}
	return { config, rows, audits, guards, resolved: () => resolved }
}
const host = { tenant: 'one', actor: 'owner' }

describe('Effect CRUD boundaries', () => {
	it('enriches from trusted context lazily, projects DTOs, and rejects excluded/unknown inputs', async () => {
		const h = harness()
		const crud = createEffectCrud(h.config)
		const execution = crud.commands.exec('notes.create', { text: 'client' }, host)
		expect(h.resolved()).toBe(0)
		const { id } = await Effect.runPromise(execution)
		expect(h.rows.get(id)).toEqual({ text: 'enriched', secret: 'server', tenant: 'one' })
		expect(h.audits).toEqual(['notes.create'])
		expect(await Effect.runPromise(crud.queries.exec('notes.get', { id }, host))).toEqual({
			text: 'enriched',
		})
		const forgedCreate = { text: 'bad', tenant: 'forged' }
		const excludedUpdate = { id, data: { text: 'bad', secret: 'leak' } }
		const unknownUpdate = { id, data: { text: 'bad', unknown: true } }
		await expect(
			Effect.runPromise(crud.commands.exec('notes.create', forgedCreate, host)),
		).rejects.toThrow()
		await expect(
			Effect.runPromise(crud.commands.exec('notes.update', excludedUpdate, host)),
		).rejects.toThrow()
		await expect(
			Effect.runPromise(crud.commands.exec('notes.update', unknownUpdate, host)),
		).rejects.toThrow()
		expect(h.audits).toHaveLength(1)
	})
	it('persists nonempty updates, accepts empty updates and archives softly on every fresh call; missing rows retain adapter behavior', async () => {
		const h = harness()
		const crud = createEffectCrud(h.config)
		const { id } = await Effect.runPromise(
			crud.commands.exec('notes.create', { text: 'first' }, host),
		)
		await Effect.runPromise(
			crud.commands.exec('notes.update', { id, data: { text: 'changed' } }, host),
		)
		expect(h.rows.get(id)).toEqual({ text: 'changed', secret: 'server', tenant: 'one' })
		expect(h.audits).toEqual(['notes.create', 'notes.update'])
		await Effect.runPromise(crud.commands.exec('notes.update', { id, data: {} }, host))
		const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
		try {
			await Effect.runPromise(crud.commands.exec('notes.archive', { id }, host))
			expect(h.rows.get(id)?.archivedAt).toBe(100)
			clock.mockReturnValue(200)
			await Effect.runPromise(crud.commands.exec('notes.archive', { id }, host))
			expect(h.rows.get(id)?.archivedAt).toBe(200)
		} finally {
			clock.mockRestore()
		}
		expect(h.rows.has(id)).toBe(true)
		expect(h.audits).toEqual([
			'notes.create',
			'notes.update',
			'notes.update',
			'notes.archive',
			'notes.archive',
		])
		await expect(
			Effect.runPromise(crud.commands.exec('notes.update', { id: 'missing', data: {} }, host)),
		).rejects.toThrow('MISSING_OR_DENIED')
		await expect(
			Effect.runPromise(crud.commands.exec('notes.archive', { id: 'missing' }, host)),
		).rejects.toThrow('MISSING_OR_DENIED')
	})
	it('bounds pagination and leaves tenant authorization to the secured read repository', async () => {
		const h = harness()
		const crud = createEffectCrud(h.config)
		const { id } = await Effect.runPromise(
			crud.commands.exec('notes.create', { text: 'mine' }, host),
		)
		expect(
			await Effect.runPromise(crud.queries.exec('notes.get', { id }, { ...host, tenant: 'two' })),
		).toBeNull()
		expect(
			await Effect.runPromise(
				crud.queries.exec('notes.list', { numItems: 2, cursor: null }, { ...host, tenant: 'two' }),
			),
		).toEqual({ page: [], isDone: true, continueCursor: '' })
		expect(
			await Effect.runPromise(crud.queries.exec('notes.list', { numItems: 2, cursor: null }, host)),
		).toEqual({ page: [{ text: 'enriched' }], isDone: true, continueCursor: '' })
		for (const numItems of [0, 3, 1.5])
			await expect(
				Effect.runPromise(crud.queries.exec('notes.list', { numItems, cursor: null }, host)),
			).rejects.toThrow()
	})
	it('requires tenant enrichment and positive pagination bounds at construction', () => {
		const h = harness()
		expect(() => createEffectCrud({ ...h.config, enrich: undefined })).toThrow(/enrich/i)
		expect(() =>
			createEffectCrud({ ...h.config, read: { ...h.config.read, maxPageSize: 0 } }),
		).toThrow(/page/i)
	})
	it('retains shared guard, permission, and audit around an archive override', async () => {
		const h = harness()
		const crud = createEffectCrud({
			...h.config,
			overrides: {
				archive: (_input, ctx) => {
					expect(ctx.tenant).toBe('one')
					return { ok: true as const }
				},
			},
		})
		await Effect.runPromise(crud.commands.exec('notes.archive', { id: 'id_1' }, host))
		expect(h.guards).toEqual(['owner'])
		expect(h.audits).toEqual(['notes.archive'])
		await expect(
			Effect.runPromise(
				crud.commands.exec('notes.archive', { id: 'id_1' }, { ...host, actor: 'denied' }),
			),
		).rejects.toThrow('DENIED')
		expect(h.audits).toHaveLength(1)
	})
	it('drops undefined create fields before repository writes', async () => {
		const optional = zodTable(
			'optional',
			() => ({ text: z.string(), optional: z.string().optional() }),
			{ commandFields: ['text', 'optional'], publicFields: ['text'] },
		)
		const h = harness()
		let saved: z.input<typeof optional.storage> | undefined
		const crud = createEffectCrud({
			...h.config,
			table: optional,
			checkId: (_ctx, id) => id === 'id_1',
			enrich: undefined,
			repository: {
				insert: (_ctx, values) => {
					saved = values
					return optional.tools.id.parse({ id: 'id_1' }).id
				},
				patch: () => undefined,
			},
			read: {
				maxPageSize: 2,
				project: (row) => ({ text: row.text }),
				get: () => null,
				list: () => ({ page: [], isDone: true, continueCursor: '' }),
			},
		})
		await Effect.runPromise(
			crud.commands.exec('optional.create', { text: 'yes', optional: undefined }, host),
		)
		expect(saved).toEqual({ text: 'yes' })
	})
})

describe('retained CRUD policy and read projection', () => {
	it('runs shared policy and local guards; shared denial prevents a locally permitted operation', async () => {
		const h = harness()
		const events: string[] = []
		const crud = createEffectCrud({
			...h.config,
			policy: {
				guard: (ctx) => {
					events.push('shared')
					if (ctx.actor === 'denied') throw Error('SHARED_DENIAL')
				},
			},
			guards: {
				archive: (ctx, input) => {
					events.push(`local:${ctx.tenant}:${input.id}`)
				},
				get: () => {
					events.push('get-local')
				},
			},
			overrides: { archive: () => ({ ok: true as const }) },
		})
		await Effect.runPromise(crud.commands.exec('notes.archive', { id: 'id_1' }, host))
		expect(events).toEqual(['shared', 'local:one:id_1'])
		await expect(
			Effect.runPromise(
				crud.commands.exec('notes.archive', { id: 'id_1' }, { ...host, actor: 'denied' }),
			),
		).rejects.toThrow('SHARED_DENIAL')
		await expect(
			Effect.runPromise(
				crud.queries.exec('notes.get', { id: 'id_1' }, { ...host, actor: 'denied' }),
			),
		).rejects.toThrow('SHARED_DENIAL')
		expect(events).toEqual(['shared', 'local:one:id_1', 'shared', 'shared'])
		expect(h.audits).toEqual(['notes.archive'])
	})
	it('validates the public mask even for a misconfigured projection', async () => {
		const h = harness()
		const crud = createEffectCrud({
			...h.config,
			read: { ...h.config.read, project: (row) => row },
		})
		const { id } = await Effect.runPromise(
			crud.commands.exec('notes.create', { text: 'mine' }, host),
		)
		await expect(Effect.runPromise(crud.queries.exec('notes.get', { id }, host))).rejects.toThrow()
	})
	it.each(['initial', 'split'] as const)(
		'accepts helper-decoded %s pagination options through the generated executor',
		async (kind) => {
			const h = harness()
			const request: EffectCrudPagination = {
				numItems: 2,
				cursor: kind === 'initial' ? null : 'start',
				id: 7,
			}
			if (kind === 'split') request.endCursor = 'end'
			const options = paginated(table.publicDto).args.paginationOpts.parse(request)
			const received: EffectCrudPagination[] = []
			const page = {
				page: [{ text: 'public', secret: 'private', tenant: 'one' }],
				isDone: false,
				continueCursor: 'end',
				splitCursor: 'middle',
				pageStatus: 'SplitRecommended' as const,
			}
			const crud = createEffectCrud({
				...h.config,
				read: {
					...h.config.read,
					list: (_ctx, input) => {
						received.push(input)
						return page
					},
				},
			})
			const execution = crud.queries.exec('notes.list', options, host)
			expect(received).toEqual([])
			expect(h.resolved()).toBe(0)
			expect(await Effect.runPromise(execution)).toEqual({
				...page,
				page: [{ text: 'public' }],
			})
			expect(received).toEqual([expect.objectContaining(options)])
		},
	)
	it.each(['SplitRecommended', 'SplitRequired'] as const)(
		'accepts a grown page and preserves %s metadata without slicing its range',
		async (pageStatus) => {
			const h = harness()
			const grown = createEffectCrud({
				...h.config,
				read: {
					...h.config.read,
					list: () => ({
						page: Array.from({ length: 3 }, () => ({
							text: 'public',
							secret: 'private',
							tenant: 'one',
						})),
						isDone: false,
						continueCursor: 'end',
						splitCursor: 'middle',
						pageStatus,
					}),
				},
			})
			expect(
				await Effect.runPromise(
					grown.queries.exec('notes.list', { numItems: 2, cursor: null }, host),
				),
			).toEqual({
				page: [{ text: 'public' }, { text: 'public' }, { text: 'public' }],
				isDone: false,
				continueCursor: 'end',
				splitCursor: 'middle',
				pageStatus,
			})
		},
	)
	it.each(['ordinary', 'promise', 'effect'] as const)(
		'passes server-owned read budgets and native options lazily to a %s reader',
		async (kind) => {
			const h = harness()
			const received: EffectCrudPagination[] = []
			const page = { page: [], isDone: true, continueCursor: '' }
			const crud = createEffectCrud({
				...h.config,
				read: {
					...h.config.read,
					maximumRowsRead: 5,
					list: (_ctx, input) => {
						received.push(input)
						return kind === 'ordinary'
							? page
							: kind === 'promise'
								? Promise.resolve(page)
								: Effect.succeed(page)
					},
				},
			})
			for (const budget of [undefined, 3, 500]) {
				const request: EffectCrudPagination = {
					numItems: 2,
					cursor: 'start',
					endCursor: 'end',
					id: 7,
					maximumBytesRead: 1024,
				}
				if (budget !== undefined) request.maximumRowsRead = budget
				const options = paginated(table.publicDto).args.paginationOpts.parse(request)
				const before = received.length
				const execution = crud.queries.exec('notes.list', options, host)
				expect(received).toHaveLength(before)
				expect(await Effect.runPromise(execution)).toEqual(page)
				expect(received.at(-1)).toEqual({
					...options,
					maximumRowsRead: budget === 3 ? 3 : 5,
				})
			}
		},
	)
	it('defaults the server read budget to maxPageSize before calling the reader', async () => {
		const h = harness()
		const received: EffectCrudPagination[] = []
		const crud = createEffectCrud({
			...h.config,
			read: {
				...h.config.read,
				list: (_ctx, input) => {
					received.push(input)
					return { page: [], isDone: true, continueCursor: '' }
				},
			},
		})
		await Effect.runPromise(crud.queries.exec('notes.list', { numItems: 1, cursor: null }, host))
		expect(received).toEqual([{ numItems: 1, cursor: null, maximumRowsRead: 2 }])
	})
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
		'requires a positive safe integer server row budget (%s)',
		async (maximumRowsRead) => {
			const h = harness()
			expect(() =>
				createEffectCrud({
					...h.config,
					read: { ...h.config.read, maximumRowsRead },
				}),
			).toThrow('CRUD maximumRowsRead must be a positive safe integer')
		},
	)
})

const securedSchema = defineSchema({
	notes: table.table.index('by_tenant', ['tenant']),
	history: defineTable({
		tenant: v.string(),
		text: v.string(),
		archivedAt: v.optional(v.number()),
	}),
	audits: defineTable({ operation: v.string() }),
})
type SecuredModel = DataModelFromSchemaDefinition<typeof securedSchema>
type SecuredHost = {
	db: GenericDatabaseReader<SecuredModel>
	actor: { userId: string }
	tenant: string
	failAudit?: boolean
}
class Writer extends Context.Service<Writer, GenericDatabaseWriter<SecuredModel>>()(
	'CrudSecuredWriter',
) {}
const createRef = makeFunctionReference<
	'mutation',
	{ text: string; failAudit?: boolean; failOutput?: boolean },
	{ id: Id }
>('functions:create')
const getRef = makeFunctionReference<'query', { id: Id }, { text: string } | null>('functions:get')
const listRef = makeFunctionReference<
	'query',
	EffectCrudPagination,
	{ page: { text: string }[]; isDone: boolean; continueCursor: string }
>('functions:list')
function securedHarness() {
	const triggers = createTriggers<SecuredModel>()
	triggers.register('notes', async (ctx, change) => {
		if (change.operation === 'insert')
			await ctx.innerDb.insert('history', {
				tenant: change.newDoc.tenant,
				text: change.newDoc.text,
			})
	})
	const auth = createAuthFunctions<SecuredModel, 'owner' | 'viewer'>({
		triggers,
		query: queryGeneric,
		mutation: mutationGeneric,
		action: actionGeneric,
		internalQuery: internalQueryGeneric,
		internalMutation: internalMutationGeneric,
		internalAction: internalActionGeneric,
		getAuthUser: async (ctx) => {
			const identity = await ctx.auth.getUserIdentity()
			return identity ? { id: identity.subject } : null
		},
		mapRole: (role) => (role === 'owner' || role === 'viewer' ? role : null),
		adminRoles: ['owner'],
		security: {
			tenancy: { tables: ['notes', 'history'] },
			rules: (bundle) => ({
				notes: { insert: async () => bundle.role === 'owner' },
				audits: { insert: async () => true },
			}),
		},
	})
	const observed: { notes: number; history: number; audits: number }[] = []
	const foundation = createEffectFoundation({
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
		},
		writeAudit: (ctx: SecuredHost, entry) =>
			Effect.gen(function* () {
				const writer = yield* Writer
				yield* Effect.promise(() => writer.insert('audits', { operation: entry.operation }))
				if (ctx.failAudit) {
					const notes = yield* Effect.promise(() => writer.query('notes').collect())
					const history = yield* Effect.promise(() => writer.query('history').collect())
					observed.push({ notes: notes.length, history: history.length, audits: 1 })
					return yield* Effect.fail(Error('AUDIT_FAILURE'))
				}
			}),
	})
	const configuration = {
		foundation,
		table,
		context: (ctx: SecuredHost) => ctx,
		aggregateType: 'note',
		actor: (ctx: SecuredHost) => ctx.actor.userId,
		enrich: (ctx: SecuredHost) => ({ tenant: ctx.tenant, secret: ctx.actor.userId }),
		repository: {
			insert: (_ctx: SecuredHost, values: Row) =>
				Effect.gen(function* () {
					const db = yield* Writer
					return yield* Effect.promise(() => db.insert('notes', values))
				}),
			patch: (_ctx: SecuredHost, id: Id, values: Partial<Row>) =>
				Effect.gen(function* () {
					const db = yield* Writer
					yield* Effect.promise(() => db.patch(id, values))
				}),
		},
		read: {
			maxPageSize: 2,
			project: (row: Row) => ({ text: row.text }),
			get: (ctx: SecuredHost, id: Id) => ctx.db.get(id),
			list: (ctx: SecuredHost, input: EffectCrudPagination) =>
				ctx.db
					.query('notes')
					.withIndex('by_tenant', (q) => q.eq('tenant', ctx.tenant))
					.paginate(input),
		},
	}
	const crud = createEffectCrud(configuration)
	const badOutput = createEffectCrud({
		...configuration,
		overrides: {
			// @ts-expect-error deliberate invalid output after a real secured write, to exercise rollback
			create: (input, ctx) =>
				Effect.gen(function* () {
					const db = yield* Writer
					yield* Effect.promise(() =>
						db.insert('notes', { text: input.text, tenant: ctx.tenant, secret: ctx.actor.userId }),
					)
					const notes = yield* Effect.promise(() => db.query('notes').collect())
					const history = yield* Effect.promise(() => db.query('history').collect())
					observed.push({ notes: notes.length, history: history.length, audits: 0 })
					return { id: 42 }
				}),
		},
	})
	const mutation = effectZodApiBuilder(auth.authMutation, {
		services: (ctx) => Context.make(Writer, ctx.db),
	})
	const query = effectZodApiBuilder(auth.authQuery, { services: () => Context.empty() })
	const create = mutation({
		args: {
			text: z.string(),
			failAudit: z.boolean().optional(),
			failOutput: z.boolean().optional(),
		},
		returns: z.object({ id: table.tools.id.shape.id }),
		handler: (ctx, input) => {
			if (input.failOutput)
				return badOutput.commands.exec('notes.create', { text: input.text }, ctx)
			return crud.commands.exec(
				'notes.create',
				{ text: input.text },
				{ ...ctx, failAudit: input.failAudit },
			)
		},
	})
	const get = query({
		args: table.tools.id.shape,
		returns: table.publicDto.nullable(),
		handler: (ctx, args) => crud.queries.exec('notes.get', args, ctx),
	})
	const list = query({
		args: { numItems: z.number(), cursor: z.string().nullable() },
		returns: z.object({
			page: z.array(table.publicDto),
			isDone: z.boolean(),
			continueCursor: z.string(),
		}),
		handler: (ctx, args) => crud.queries.exec('notes.list', args, ctx),
	})
	// Plain string bindings exercise the generated runtime boundary independently of native zid.
	const update = mutation({
		args: { id: z.string(), data: z.object({ text: z.string().optional() }) },
		returns: z.object({ ok: z.literal(true) }),
		handler: (ctx, input) => crud.commands.exec('notes.update', input, ctx),
	})
	const archive = mutation({
		args: { id: z.string() },
		returns: z.object({ ok: z.literal(true) }),
		handler: (ctx, input) => crud.commands.exec('notes.archive', input, ctx),
	})
	const t = convexTest(securedSchema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ create, get, list, update, archive }),
	})
	const stored = () =>
		t.run(async (ctx) => ({
			notes: await ctx.db.query('notes').collect(),
			history: await ctx.db.query('history').collect(),
			audits: await ctx.db.query('audits').collect(),
		}))
	return { t, stored, observed }
}
const owner = { subject: 'owner', org_id: 'one', role: 'owner' }
describe('registered secured CRUD under convex-test', () => {
	it('rolls back secured writes, trigger writes, and audit after audit failure', async () => {
		const h = securedHarness()
		await expect(
			h.t.withIdentity(owner).mutation(createRef, { text: 'rollback', failAudit: true }),
		).rejects.toThrow('AUDIT_FAILURE')
		expect(h.observed).toEqual([{ notes: 1, history: 1, audits: 1 }])
		expect(await h.stored()).toEqual({ notes: [], history: [], audits: [] })
	})
	it('rolls back secured writes and trigger writes after command output failure', async () => {
		const h = securedHarness()
		await expect(
			h.t.withIdentity(owner).mutation(createRef, { text: 'rollback', failOutput: true }),
		).rejects.toThrow()
		expect(h.observed).toEqual([{ notes: 1, history: 1, audits: 0 }])
		expect(await h.stored()).toEqual({ notes: [], history: [], audits: [] })
	})
	it('injects Writer only for mutations; reader-only queries preserve RLS and the public mask', async () => {
		const h = securedHarness()
		const asOwner = h.t.withIdentity(owner)
		const { id } = await asOwner.mutation(createRef, { text: 'safe' })
		expect((await h.stored()).audits).toHaveLength(1)
		expect(await asOwner.query(getRef, { id })).toEqual({ text: 'safe' })
		const foreign = h.t.withIdentity({ ...owner, org_id: 'two' })
		expect(await foreign.query(getRef, { id })).toBeNull()
		expect((await foreign.query(listRef, { numItems: 2, cursor: null })).page).toEqual([])
		await expect(
			h.t.withIdentity({ ...owner, role: 'viewer' }).mutation(createRef, { text: 'denied' }),
		).rejects.toThrow()
	})
})

describe('CRUD table membership and public projection', () => {
	it.each(['get', 'update', 'archive'] as const)(
		'rejects a same-tenant foreign-table ID before %s and audit',
		async (verb) => {
			const h = securedHarness()
			const foreignId = await h.t.run((ctx) =>
				ctx.db.insert('history', { tenant: 'one', text: 'foreign' }),
			)
			const before = await h.stored()
			const asOwner = h.t.withIdentity(owner)
			// tools.id's brand does not prove table membership at runtime.
			const execution =
				verb === 'get'
					? asOwner.query(getRef, { id: table.tools.id.parse({ id: foreignId }).id })
					: asOwner.mutation(
							makeFunctionReference<'mutation'>(`functions:${verb}`),
							verb === 'update' ? { id: foreignId, data: { text: 'changed' } } : { id: foreignId },
						)
			await expect(execution).rejects.toThrow(/Invalid ID/)
			expect(await h.stored()).toEqual(before)
		},
	)
	it.each(['get', 'list'] as const)(
		'decodes a non-idempotent public transform exactly once for %s',
		async (verb) => {
			let transforms = 0
			const transformed = zodTable(
				'transformed',
				() => ({
					text: z.string().transform((value) => {
						transforms++
						return value + '!'
					}),
				}),
				{ commandFields: ['text'], publicFields: ['text'] },
			)
			const h = harness()
			const crud = createEffectCrud({
				...h.config,
				table: transformed,
				checkId: (_ctx, id) => id === 'id_1',
				enrich: undefined,
				repository: {
					insert: () => transformed.tools.id.parse({ id: 'id_1' }).id,
					patch: () => undefined,
				},
				read: {
					maxPageSize: 2,
					project: (row) => ({ text: row.text }),
					get: () => ({ text: 'hello' }),
					list: () => ({ page: [{ text: 'hello' }], isDone: true, continueCursor: '' }),
				},
			})
			if (verb === 'get') {
				expect(
					await Effect.runPromise(crud.queries.exec('transformed.get', { id: 'id_1' }, host)),
				).toEqual({ text: 'hello!' })
			} else {
				expect(
					(
						await Effect.runPromise(
							crud.queries.exec('transformed.list', { numItems: 2, cursor: null }, host),
						)
					).page,
				).toEqual([{ text: 'hello!' }])
			}
			expect(transforms).toBe(1)
		},
	)
})

describe('checked CRUD callbacks and storage contracts', () => {
	it.each(['ordinary', 'promise', 'effect'] as const)(
		'runs a lazy %s membership checker before reads, overrides or audit',
		async (kind) => {
			const h = harness()
			let checks = 0
			const reached: string[] = []
			const crud = createEffectCrud({
				...h.config,
				checkId: (_ctx, id) => {
					checks++
					const valid = id === 'id_1'
					return kind === 'ordinary'
						? valid
						: kind === 'promise'
							? Promise.resolve(valid)
							: Effect.succeed(valid)
				},
				overrides: {
					update: () => {
						reached.push('update')
						return { ok: true as const }
					},
					archive: () => {
						reached.push('archive')
						return { ok: true as const }
					},
				},
				read: {
					...h.config.read,
					get: () => {
						reached.push('get')
						return null
					},
				},
			})
			const invalidGet = crud.queries.exec('notes.get', { id: 'foreign' }, host)
			expect(checks).toBe(0)
			expect(h.resolved()).toBe(0)
			await expect(Effect.runPromise(invalidGet)).rejects.toMatchObject({ code: 'CRUD_INVALID_ID' })
			await expect(
				Effect.runPromise(crud.commands.exec('notes.update', { id: 'foreign', data: {} }, host)),
			).rejects.toMatchObject({ code: 'CRUD_INVALID_ID' })
			await expect(
				Effect.runPromise(crud.commands.exec('notes.archive', { id: 'foreign' }, host)),
			).rejects.toMatchObject({ code: 'CRUD_INVALID_ID' })
			expect(checks).toBe(3)
			expect(reached).toEqual([])
			expect(h.audits).toEqual([])
			await Effect.runPromise(crud.commands.exec('notes.update', { id: 'id_1', data: {} }, host))
			await Effect.runPromise(crud.commands.exec('notes.archive', { id: 'id_1' }, host))
			await Effect.runPromise(crud.queries.exec('notes.get', { id: 'id_1' }, host))
			expect(reached).toEqual(['update', 'archive', 'get'])
			expect(h.audits).toEqual(['notes.update', 'notes.archive'])
		},
	)
	it('propagates a checker Effect failure before an overridden handler', async () => {
		const h = harness()
		let reached = false
		const failure = Error('CHECK_FAILURE')
		const crud = createEffectCrud({
			...h.config,
			checkId: () => Effect.fail(failure),
			overrides: {
				archive: () => {
					reached = true
					return { ok: true as const }
				},
			},
		})
		await expect(
			Effect.runPromise(crud.commands.exec('notes.archive', { id: 'id_1' }, host)),
		).rejects.toBe(failure)
		expect(reached).toBe(false)
		expect(h.audits).toEqual([])
	})
	it('preserves native missing-row behavior for a valid deleted ID', async () => {
		const h = securedHarness()
		const asOwner = h.t.withIdentity(owner)
		const { id } = await asOwner.mutation(createRef, { text: 'deleted' })
		await h.t.run((ctx) => ctx.db.delete(id))
		const before = await h.stored()
		expect(await asOwner.query(getRef, { id })).toBeNull()
		await expect(
			asOwner.mutation(makeFunctionReference<'mutation'>('functions:update'), { id, data: {} }),
		).rejects.not.toThrow('Invalid ID')
		await expect(
			asOwner.mutation(makeFunctionReference<'mutation'>('functions:archive'), { id }),
		).rejects.not.toThrow('Invalid ID')
		expect(await h.stored()).toEqual(before)
	})
	it('writes compatible same-type command transforms once without storage reparsing', async () => {
		let transforms = 0
		const transformed = zodTable(
			'sameType',
			() => ({
				text: z.string().transform((value) => {
					transforms++
					return value + '!'
				}),
			}),
			{ commandFields: ['text'], publicFields: ['text'] },
		)
		const h = harness()
		let saved: z.input<typeof transformed.storage> | undefined
		const crud = createEffectCrud({
			...h.config,
			table: transformed,
			enrich: undefined,
			checkId: (_ctx, id) => id === 'id_1',
			repository: {
				insert: (_ctx, values) => {
					saved = values
					return transformed.tools.id.parse({ id: 'id_1' }).id
				},
				patch: (_ctx, _id, values) => {
					saved = { ...saved!, ...values }
				},
			},
			read: {
				maxPageSize: 2,
				project: (row) => ({ text: row.text }),
				get: () => saved ?? null,
				list: () => ({ page: [], isDone: true, continueCursor: '' }),
			},
		})
		const { id } = await Effect.runPromise(
			crud.commands.exec('sameType.create', { text: 'hello' }, host),
		)
		expect(saved).toEqual({ text: 'hello!' })
		expect(transforms).toBe(1)
		transforms = 0
		await Effect.runPromise(
			crud.commands.exec('sameType.update', { id, data: { text: 'changed' } }, host),
		)
		expect(saved).toEqual({ text: 'changed!' })
		expect(transforms).toBe(1)
		expect(h.audits).toEqual(['sameType.create', 'sameType.update'])
	})
	it('maps incompatible decoded fields through retained-contract overrides without reparsing', async () => {
		let transforms = 0
		const transformed = zodTable(
			'lengths',
			() => ({
				text: z.string().transform((value) => {
					transforms++
					return value.length
				}),
			}),
			{ commandFields: ['text'], publicFields: ['text'] },
		)
		const h = harness()
		let saved: z.input<typeof transformed.storage> | undefined
		const repository = {
			insert: (
				_ctx: ReturnType<typeof h.config.context>,
				values: z.input<typeof transformed.storage>,
			) => {
				saved = values
				return transformed.tools.id.parse({ id: 'id_1' }).id
			},
			patch: (
				_ctx: ReturnType<typeof h.config.context>,
				_id: z.output<typeof transformed.tools.id>['id'],
				values: Partial<z.input<typeof transformed.storage>>,
			) => {
				saved = { ...saved!, ...values }
			},
		}
		const crud = createEffectCrud({
			...h.config,
			table: transformed,
			enrich: undefined,
			checkId: (_ctx, id) => id === 'id_1',
			repository,
			overrides: {
				create: (input, ctx) => ({ id: repository.insert(ctx, { text: String(input.text) }) }),
				update: (input, ctx) => {
					repository.patch(
						ctx,
						input.id,
						input.data.text === undefined ? {} : { text: String(input.data.text) },
					)
					return { ok: true as const }
				},
			},
			read: {
				maxPageSize: 2,
				project: (row) => ({ text: row.text }),
				get: () => saved ?? null,
				list: () => ({ page: [], isDone: true, continueCursor: '' }),
			},
		})
		const { id } = await Effect.runPromise(
			crud.commands.exec('lengths.create', { text: 'hello' }, host),
		)
		expect(saved).toEqual({ text: '5' })
		expect(transforms).toBe(1)
		transforms = 0
		await Effect.runPromise(
			crud.commands.exec('lengths.update', { id, data: { text: 'four' } }, host),
		)
		expect(saved).toEqual({ text: '4' })
		expect(transforms).toBe(1)
		expect(h.audits).toEqual(['lengths.create', 'lengths.update'])
	})
})

it.each([1, 'yes', {}])(
	'rejects malformed truthy checker success %j before an override',
	async (malformed) => {
		const h = harness()
		let reached = false
		const crud = createEffectCrud({
			...h.config,
			checkId: (): boolean => {
				// @ts-expect-error deliberately malformed trusted callback tests runtime boolean enforcement
				return malformed
			},
			overrides: {
				archive: () => {
					reached = true
					return { ok: true as const }
				},
			},
		})
		await expect(
			Effect.runPromise(crud.commands.exec('notes.archive', { id: 'id_1' }, host)),
		).rejects.toMatchObject({ code: 'CRUD_INVALID_ID' })
		expect(reached).toBe(false)
		expect(h.audits).toEqual([])
	},
)
