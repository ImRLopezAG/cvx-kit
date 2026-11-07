import { convexTest } from 'convex-test'
import workflowTest from '@convex-dev/workflow/test'
import {
	defineSchema,
	mutationGeneric,
	queryGeneric,
	componentsGeneric,
	type DataModelFromSchemaDefinition,
	type GenericMutationCtx,
	type GenericQueryCtx,
	type MutationBuilder,
	type QueryBuilder,
	type ApiFromModules,
	type GenericDatabaseReader,
} from 'convex/server'
import { NoOp } from 'convex-helpers/server/customFunctions'
import { zCustomMutation, zCustomQuery } from 'convex-helpers/server/zod4'
import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { tenantTable, zodTable, paginated } from '../src/zod-table'
import { defineRelations } from '../src/relations-public'
import { createQueryEngine } from '../src/querying'
import { createInclude } from '../src/auth'
import { createTenantRules, wrapDatabaseReader, wrapDatabaseWriter } from '../src/tenancy'
import { createTriggers, timestamps, tenantOwnership, triggerContext } from '../src/triggers'
import { createEffectFoundation, effectZodApiBuilder } from '../src/effect'
import { createEffectCrud, type EffectCrudPagination } from '../src/effect'
import { defineErrorContract, decodeFailure } from '../src/errors'

// Only component-local IDs are branded; host references are opaque strings.
const notes = tenantTable(
	'notes',
	(id) => ({
		text: z.string(),
		secret: z.string(),
		parent: id('notes').nullable(),
		hostRun: z.string(),
	}),
	{ commandFields: ['text'], publicFields: ['text'] },
)
const audits = zodTable('audits', () => ({
	actor: z.string(),
	tenant: z.string(),
	operation: z.string(),
}))
const schema = defineSchema({
	notes: notes.table.index('by_tenant', ['tenant']),
	audits: audits.table,
})
type DM = DataModelFromSchemaDefinition<typeof schema>
type MC = GenericMutationCtx<DM>
type QC = GenericQueryCtx<DM>
const mutation: MutationBuilder<DM, 'public'> = mutationGeneric
const query: QueryBuilder<DM, 'public'> = queryGeneric
const scopeSchema = z.object({ actor: z.string(), tenant: z.string() })
type Scope = z.output<typeof scopeSchema>
type Host = Scope & { db: GenericDatabaseReader<DM>; writer?: MC['db']; failAudit?: boolean }
type Row = z.input<typeof notes.storage>
type NoteId = z.output<typeof notes.tools.id>['id']
function requireWriter(ctx: Host) {
	if (!ctx.writer) throw Error('Mutation context required')
	return ctx.writer
}
const errors = defineErrorContract({ DENIED: { message: 'Access denied', details: {} } })
const hostErrors = defineErrorContract({
	OMNI_DENIED: { message: 'Omni access denied', details: {} },
})
const triggers = createTriggers<DM>()
timestamps(triggers, 'notes', 'audits')
tenantOwnership(triggers, 'notes')
const componentMutation = effectZodApiBuilder(zCustomMutation(mutation, triggerContext(triggers)), {
	errors,
})
const componentQuery = effectZodApiBuilder(zCustomQuery(query, NoOp), { errors })
const relations = defineRelations(
	{ audits, notes: { ...notes, fieldGroups: { private: ['secret'] as const } } },
	(r) => ({
		notes: { parentNote: r.one.notes({ from: r.notes.parent, to: r.notes._id }) },
	}),
)
const observed: string[] = []
const foundation = createEffectFoundation({
	observability: {
		enabled: true,
		classifyError: () => ({ outcome: 'failed', errorCode: 'COMPONENT_FAILURE' }),
		emit: (entry) => {
			observed.push(`${entry.operation}:${entry.outcome}:${entry.errorCode ?? ''}`)
		},
	},
	checkPermission: (ctx: Host) =>
		ctx.actor === 'denied' ? Effect.fail(errors.create('DENIED', {})) : Effect.void,
	writeAudit: async (ctx: Host, entry) => {
		await requireWriter(ctx).insert('audits', {
			actor: ctx.actor,
			tenant: ctx.tenant,
			operation: entry.operation,
		})
		if (ctx.failAudit) throw Error('private audit failure')
	},
})
function writer(ctx: MC, scope: Scope): Host {
	const db = wrapDatabaseWriter({}, ctx.db, createTenantRules<DM>(scope.tenant, ['notes']), {
		defaultPolicy: 'allow',
	})
	return { ...scope, db, writer: db }
}
const crud = createEffectCrud({
	foundation,
	table: notes,
	aggregateType: 'note',
	policy: { permissions: { create: 'notes.write' } },
	context: (ctx: Host) => ctx,
	actor: (ctx: Host) => ctx.actor,
	enrich: (ctx: Host) => ({
		tenant: ctx.tenant,
		secret: ctx.actor,
		parent: null,
		hostRun: 'host:run',
	}),
	repository: {
		insert: (ctx: Host, values: Row) =>
			requireWriter(ctx).insert('notes', notes.storage.parse(values)),
		patch: async (ctx: Host, id: NoteId, values: Partial<Row>) => {
			await requireWriter(ctx).patch(id, notes.storage.partial().parse(values))
		},
	},
	read: {
		maxPageSize: 10,
		project: (row: Row) => notes.toPublicDto(row),
		get: (ctx: Host, id: NoteId) => ctx.db.get(id),
		list: (ctx: Host, input: EffectCrudPagination) =>
			ctx.db
				.query('notes')
				.withIndex('by_tenant', (q) => q.eq('tenant', ctx.tenant))
				.paginate(input),
	},
})
const create = componentMutation({
	args: { scope: scopeSchema, text: z.string(), failAudit: z.boolean().optional() },
	returns: z.object({ id: notes.schema.shape._id }),
	handler: (ctx, args) =>
		crud.commands.exec(
			'notes.create',
			{ text: args.text },
			{ ...writer(ctx, args.scope), failAudit: args.failAudit },
		),
})
const get = componentQuery({
	args: { scope: scopeSchema, id: notes.schema.shape._id },
	returns: notes.publicDto.nullable(),
	handler: (ctx, { scope, id }) =>
		crud.queries.exec(
			'notes.get',
			{ id },
			{
				...ctx,
				...scope,
				db: wrapDatabaseReader({}, ctx.db, createTenantRules<DM>(scope.tenant, ['notes']), {
					defaultPolicy: 'deny',
				}),
			},
		),
})
// Factory lives in component-root querying.ts in consumer code. Never cache
// request authority or read environment variables inside a component.
function createComponentQuerying(ctx: QC, scope: Scope, key: number[]) {
	const reader = { db: ctx.db }
	const engine = createQueryEngine(
		{ schema, relations },
		{
			cursor: { version: '1', currentKeyId: 'host', keys: { host: new Uint8Array(key) } },
			trustedAdapter: (candidate) =>
				candidate === reader
					? {
							reader: ctx.db,
							scope: {
								mode: 'trusted',
								principal: scope.actor,
								tenant: scope.tenant,
								organization: null,
								role: null,
							},
							rules: createTenantRules<DM>(scope.tenant, ['notes']),
							defaultPolicy: 'deny',
						}
					: null,
			fieldGroups: { notes: { private: ({ scope }) => scope.principal === 'owner' } },
		},
	)
	return engine(reader)
}
const pageArgs = relations.tables.notes.paginationOpts({ text: true })
const list = componentQuery({
	args: { scope: scopeSchema, key: z.array(z.number()), page: pageArgs },
	returns: relations.tables.notes.pageDto({ parentNote: true }),
	handler: (ctx, { scope, key, page }) =>
		createComponentQuerying(ctx, scope, key).notes.with({ parentNote: true }).paginate(page),
})
const privateList = componentQuery({
	args: { scope: scopeSchema, key: z.array(z.number()) },
	returns: relations.tables.notes.pageDto({}, { fieldGroups: { private: 'required' } }),
	handler: (ctx, { scope, key }) =>
		createComponentQuerying(ctx, scope, key)
			.notes.include({ private: 'required' })
			.paginate({ numItems: 2, cursor: null }),
})
const include = createInclude({ maxRows: 10 })
const nativePage = paginated(notes.publicDto)
const bounded = componentQuery({
	args: { scope: scopeSchema, limit: z.number() },
	returns: z.array(notes.publicDto),
	handler: (ctx, { scope, limit }) =>
		include(
			wrapDatabaseReader({}, ctx.db, createTenantRules<DM>(scope.tenant, ['notes']), {
				defaultPolicy: 'deny',
			}).query('notes'),
		)
			.matching('by_tenant', (q) => q.eq('tenant', scope.tenant))
			.execute(limit, (rows) => rows.map((row) => notes.toPublicDto(row))),
})
const native = componentQuery({
	args: { scope: scopeSchema, ...nativePage.args },
	returns: nativePage.result,
	handler: (ctx, { scope, paginationOpts }) =>
		include(
			wrapDatabaseReader({}, ctx.db, createTenantRules<DM>(scope.tenant, ['notes']), {
				defaultPolicy: 'deny',
			}).query('notes'),
		)
			.matching('by_tenant', (q) => q.eq('tenant', scope.tenant))
			.paginate(paginationOpts, (rows) => rows.map((row) => notes.toPublicDto(row))),
})
const reassign = componentMutation({
	args: { scope: scopeSchema, id: notes.schema.shape._id, tenant: z.string() },
	returns: z.null(),
	handler: async (ctx, { scope, id, tenant }) => {
		await requireWriter(writer(ctx, scope)).patch(id, { tenant })
		return null
	},
})
const fail = componentQuery({
	args: {},
	returns: z.null(),
	handler: () => Effect.fail(errors.create('DENIED', {})),
})
const unknown = componentQuery({
	args: {},
	returns: z.null(),
	handler: () => {
		throw Error('private provider details')
	},
})
// Test-only probes are registered below, never exported in a production module.
const seed = componentMutation({
	args: { rows: z.array(notes.insertSchema.extend({ tenant: z.string() })) },
	returns: z.array(notes.schema.shape._id),
	handler: async (ctx, { rows }) => {
		const ids = []
		for (const row of rows) ids.push(await ctx.db.insert('notes', row))
		return ids
	},
})
const evidence = componentQuery({
	args: {},
	returns: z.array(audits.schema),
	handler: (ctx) => ctx.db.query('audits').take(10),
})
// The same typed child references Convex generates for the parent component.
// SAFETY: the fixture registers this exact child and package API below.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Reproduce generated child API references for this in-memory registered component.
const child = componentsGeneric().workflow as unknown as ReturnType<typeof workflowTest.register>
const childPage = componentQuery({
	args: {},
	returns: z.number(),
	handler: async (ctx) =>
		(
			await ctx.runQuery(child.workflow.list, {
				order: 'asc',
				paginationOpts: { numItems: 1, cursor: null },
			})
		).page.length,
})
const functions = {
	childPage,
	create,
	get,
	list,
	privateList,
	bounded,
	native,
	reassign,
	fail,
	unknown,
	seed,
	evidence,
}
type Component = ApiFromModules<{ functions: typeof functions }>
function createClient(component: Component) {
	return {
		create: async (ctx: Pick<MC, 'runMutation'>, scope: Scope, text: string) =>
			ctx.runMutation(component.functions.create, { scope, text }),
		fail: (ctx: Pick<QC, 'runQuery'>, privateFailure: boolean) =>
			Effect.tryPromise({
				try: () =>
					ctx.runQuery(privateFailure ? component.functions.unknown : component.functions.fail, {}),
				catch: (error) => {
					const failure = decodeFailure(error, errors)
					return failure._tag === 'DeclaredFailure' ? hostErrors.create('OMNI_DENIED', {}) : error
				},
			}),
	}
}
function setup() {
	const t = convexTest(defineSchema({}), {
		'./_generated/server.ts': async () => ({}),
		'./host.ts': async () => host,
	})
	const component = t.registerComponent<Component>('omni', schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => functions,
	})
	const client = createClient(component)
	const hostMutation = effectZodApiBuilder(zCustomMutation(mutationGeneric, NoOp), {
		errors: hostErrors,
	})
	const hostQuery = effectZodApiBuilder(zCustomQuery(queryGeneric, NoOp), { errors: hostErrors })
	const host = {
		create: hostMutation({
			args: { text: z.string() },
			returns: z.object({ id: z.string() }),
			handler: async (ctx, { text }) => {
				const identity = await ctx.auth.getUserIdentity()
				if (!identity) throw hostErrors.create('OMNI_DENIED', {})
				// Fixture membership lookup: only owner belongs to this tenant.
				if (identity.subject !== 'owner') throw hostErrors.create('OMNI_DENIED', {})
				return client.create(ctx, { actor: identity.subject, tenant: 'one' }, text)
			},
		}),
		fail: hostQuery({
			args: { privateFailure: z.boolean() },
			returns: z.null(),
			handler: (ctx, { privateFailure }) => client.fail(ctx, privateFailure),
		}),
	}
	return { t, component }
}
const key = Array.from({ length: 64 }, () => 7) // Test key only.
const one = { actor: 'owner', tenant: 'one' }
const two = { actor: 'other', tenant: 'two' }

describe('component capabilities over isolated registered tables', () => {
	it('runs tenant CRUD, timestamps, audit and observability against the component foundation', async () => {
		const { t, component } = setup()
		await expect(
			t.mutation(component.functions.create, {
				scope: { ...one, actor: 'denied' },
				text: 'denied',
			}),
		).rejects.toMatchObject({ data: errors.envelope('DENIED', {}) })
		const { id } = await t.mutation(component.functions.create, { scope: one, text: 'hello' })
		expect(await t.query(component.functions.get, { scope: one, id })).toEqual({ text: 'hello' })
		expect(await t.query(component.functions.get, { scope: two, id })).toBeNull()
		expect(await t.query(component.functions.evidence, {})).toEqual([
			expect.objectContaining({
				actor: 'owner',
				tenant: 'one',
				operation: 'notes.create',
				createdAt: expect.any(Number),
			}),
		])
		expect(observed).toContain('notes.create:completed:')
		await expect(
			t.mutation(component.functions.create, { scope: one, text: 'rollback', failAudit: true }),
		).rejects.toThrow()
		expect(observed).toContain('notes.create:failed:COMPONENT_FAILURE')
		expect(await t.query(component.functions.bounded, { scope: one, limit: 10 })).toHaveLength(1)
		expect(await t.query(component.functions.evidence, {})).toHaveLength(1)
		await expect(
			t.mutation(component.functions.reassign, { scope: one, id, tenant: 'two' }),
		).rejects.toThrow()
		await expect(
			t.mutation(component.functions.reassign, { scope: two, id, tenant: 'two' }),
		).rejects.toThrow()
		expect(await t.query(component.functions.get, { scope: one, id })).not.toBeNull()
	})
	it('pages local relations with tenant policies, DTOs and scope-bound cursors', async () => {
		const { t, component } = setup()
		const [foreign] = await t.mutation(component.functions.seed, {
			rows: [
				{ text: 'foreign', tenant: 'two', secret: 'hidden', parent: null, hostRun: 'host-run' },
			],
		})
		await t.mutation(component.functions.seed, {
			rows: ['a', 'b'].map((text) => ({
				text,
				tenant: 'one',
				secret: 'local-secret',
				parent: foreign,
				hostRun: 'host-run',
			})),
		})
		const page = await t.query(component.functions.list, {
			scope: one,
			key,
			page: { numItems: 1, cursor: null },
		})
		expect(page.page).toEqual([expect.objectContaining({ text: 'a', parentNote: null })])
		expect(Object.keys(page.page[0]).sort()).toEqual(['_id', 'parentNote', 'text'])
		const next = await t.query(component.functions.list, {
			scope: one,
			key,
			page: { numItems: 1, cursor: page.continueCursor },
		})
		expect(next.page[0].text).toBe('b')
		await expect(
			t.query(component.functions.list, {
				scope: two,
				key,
				page: { numItems: 1, cursor: page.continueCursor },
			}),
		).rejects.toThrow()
		expect(
			(await t.query(component.functions.privateList, { scope: one, key })).page[0].secret,
		).toBe('local-secret')
		await expect(
			t.query(component.functions.privateList, { scope: { ...one, actor: 'reader' }, key }),
		).rejects.toThrow()
		expect(
			notes
				.paginationOpts({ text: true })
				.safeParse({ numItems: 1, cursor: null, filters: { text: 'a' } }).success,
		).toBe(true)
	})
	it('bounds include execute and native paginated DTO reads', async () => {
		const { t, component } = setup()
		await t.mutation(component.functions.create, { scope: one, text: 'bounded' })
		expect(await t.query(component.functions.bounded, { scope: one, limit: 1 })).toEqual([
			expect.objectContaining({ text: 'bounded' }),
		])
		await expect(t.query(component.functions.bounded, { scope: one, limit: 11 })).rejects.toThrow()
		const page = await t.query(component.functions.native, {
			scope: one,
			paginationOpts: { numItems: 1, cursor: null },
		})
		expect(page.page).toEqual([expect.objectContaining({ text: 'bounded' })])
		expect(Object.keys(page.page[0]).sort()).toEqual(['text'])
	})
	it('maps declared component errors at the host and redacts unknown failures', async () => {
		const { t } = setup()
		// Calls through a root module retain host identity, unlike component contexts.
		const { makeFunctionReference } = await import('convex/server')
		const createRef = makeFunctionReference<'mutation', { text: string }, { id: string }>(
			'host:create',
		)
		const failRef = makeFunctionReference<'query', { privateFailure: boolean }, null>('host:fail')
		await expect(t.mutation(createRef, { text: 'denied' })).rejects.toThrow()
		await expect(
			t.withIdentity({ subject: 'intruder' }).mutation(createRef, { text: 'denied' }),
		).rejects.toThrow()
		await expect(
			// @ts-expect-error actor and tenant are absent from the browser-facing contract
			t.withIdentity({ subject: 'intruder' }).mutation(createRef, { text: 'spoofed', scope: one }),
		).rejects.toThrow()
		const result = await t
			.withIdentity({ subject: 'owner' })
			.mutation(createRef, { text: 'trusted' })
		expect(result.id).toBeTruthy()
		await expect(t.query(failRef, { privateFailure: false })).rejects.toMatchObject({
			data: hostErrors.envelope('OMNI_DENIED', {}),
		})
		await expect(t.query(failRef, { privateFailure: true })).rejects.toMatchObject({
			data: { _tag: 'UnknownFailure', version: 1 },
		})
	})
	it('registers a nested workflow and its workpool using the package test helper', async () => {
		const { t, component } = setup()
		workflowTest.register(t, 'omni/workflow')
		expect(await t.query(component.functions.childPage, {})).toBe(0)
	})
})
