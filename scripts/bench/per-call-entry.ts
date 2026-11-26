/* oxlint-disable anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread, anti-slop/no-reflect-get, anti-slop/no-runtime-typeof -- Benchmark harness: it invokes erased registered handlers and instruments an untyped database. */
// Each process initializes only the scenario it measures. Fixture setup and
// seeding are outside the timed region. The engine and registries start unused.
import { Effect } from 'effect'
import { z } from 'zod'
import {
	defineSchema,
	mutationGeneric,
	queryGeneric,
	type GenericDataModel,
	type GenericDatabaseReader,
} from 'convex/server'
import { defineTestApp } from 'convex-test'
import { createQueryEngine } from '../../src/querying'
import { createPlanner } from '../../src/querying/planner'
import { Observability } from '../../src/components/foundation/modules/observability/observability'
import { createCursorCodec, type CursorBinding } from '../../src/querying/cursors'
import { registerQueryReader } from '../../src/querying/security'
import { createEffectQuery } from '../../src/modules/effect/query'
import { bindEffectCommand } from '../../src/modules/effect/command'
import { enterRequestScope } from '../../src/modules/effect/scope'
import { defineRelations } from '../../src/relations'
import { zodTable } from '../../src/zod-table'
import { defineAppAuth } from './app-fixture'

type Invoke = () => unknown
type Run = (invoke: Invoke, counts?: () => object) => Promise<void>
const noTransaction = (invoke: Invoke) => (run: Run) => run(invoke)
const cursor = {
	version: 'v1',
	currentKeyId: 'bench',
	keys: { bench: new Uint8Array(64).fill(7) },
}
const scope = {
	mode: 'authenticated',
	principal: 'bench',
	tenant: 'bench',
	organization: 'bench',
	role: 'member',
} as const
const selection = { parent: { parent: true }, children: true } as const
const statuses = ['open', 'closed', 'archived'] as const
const status = { status: 'open' as const }
const several = { ...status, amountCents: { gte: 100 }, active: true, not: { ref: 'excluded' } }
const fanout = { status: { in: [...statuses] }, amountCents: { gte: 100 } }

function fixture() {
	function entity<Name extends string, Parent extends string>(name: Name, parent: Parent) {
		return zodTable(
			name,
			(id) => ({
				parentId: id(parent).optional(),
				ref: z.string(),
				status: z.enum(['open', 'closed', 'archived']),
				title: z.string().min(1).max(200),
				description: z.string().optional(),
				amountCents: z.number().int(),
				active: z.boolean(),
				tags: z.array(z.string()),
				details: z.object({ text: z.string(), notes: z.array(z.string()).optional() }),
				secret: z.string(),
			}),
			{
				publicFields: [
					'parentId',
					'ref',
					'status',
					'title',
					'description',
					'amountCents',
					'active',
					'tags',
					'details',
				],
			},
		)
	}
	const tables = {
		entity0: entity('entity0', 'entity0'),
		entity1: entity('entity1', 'entity0'),
		entity2: entity('entity2', 'entity1'),
		entity3: entity('entity3', 'entity2'),
	}
	const indexes = {
		entity0: tables.entity0.table,
		entity1: tables.entity1.table,
		entity2: tables.entity2.table
			.index('by_amount', ['amountCents'])
			.index('by_status_amount', ['status', 'amountCents'])
			.searchIndex('search_title', { searchField: 'title', filterFields: ['status'] }),
		entity3: tables.entity3.table.index('by_parentId', ['parentId']),
	}
	const relations = defineRelations(tables, (r) => ({
		entity1: { parent: r.one.entity0({ from: r.entity1.parentId, to: r.entity0._id }) },
		entity2: {
			parent: r.one.entity1({ from: r.entity2.parentId, to: r.entity1._id }),
			children: r.many.entity3({ from: r.entity2._id, to: r.entity3.parentId }),
		},
	}))
	const schema = defineSchema(indexes)
	return { schema, relations }
}

function fields(i: number) {
	return {
		ref: i % 7 === 0 ? 'excluded' : `ref-${i}`,
		status: statuses[i % 3]!,
		title: `Benchmark row ${i}`,
		description: 'Synthetic document',
		amountCents: i,
		active: i % 2 === 0,
		tags: ['benchmark', 'per-call'],
		details: { text: 'Some detail', notes: ['note'] },
	}
}

// This is a deterministic, async in-process reader for paired validation
// comparisons. Every handler executes the same lookup and returns the same value.
function registration(mode: string, size: number, mutation: boolean) {
	const { relations } = fixture()
	const compact = relations.tables.entity2.paginationOpts(
		{ status: true, amountCents: true, active: true, ref: true },
		{ validator: 'compact' },
	)
	const small = z.object({ count: z.number(), prefix: z.string() })
	const args = size === 1 ? small : compact
	const payload =
		size === 1
			? { count: 1, prefix: 'bench' }
			: {
					cursor: null,
					numItems: size,
					order: 'asc',
					filters: several,
				}
	const page = {
		page: Array.from({ length: size }, (_, i) => ({
			...fields(i),
			_id: `bench-row-${i}`,
		})),
		isDone: false,
		continueCursor: 'bench-cursor',
	}
	const rows = new Map([['bench', size === 1 ? 'one row' : page]])
	const ctx = {
		auth: {
			getUserIdentity: async () => ({
				subject: 'bench',
				issuer: 'bench',
				tokenIdentifier: 'bench|bench',
				org_id: 'bench',
				role: 'member',
			}),
		},
		db: {
			system: { get() {}, query() {}, normalizeId() {} },
			get() {},
			query() {},
			normalizeId() {},
		},
		read: async (key: string) => rows.get(key),
	}
	const handler = async (context: typeof ctx) => context.read('bench')
	const auth = defineAppAuth()
	// Erase the dynamic scenario/config selection. Invoke the real registered
	// wrapper, bypassing SDK transport and Convex-native validation.
	const build = (
		mode === 'bare'
			? mutation
				? mutationGeneric
				: queryGeneric
			: mutation
				? auth.authMutation
				: auth.authQuery
	) as (definition: object) => unknown
	const fn = build({
		handler,
		...(mode === 'args' || mode === 'both' ? { args } : {}),
		...(mode === 'result' || mode === 'both'
			? { returns: size === 1 ? z.string() : relations.tables.entity2.pageDto({}) }
			: {}),
	}) as { _handler: (ctx: object, input: object) => Promise<unknown> }
	return noTransaction(() => fn._handler({ ...ctx }, payload))
}

function instrument<DM extends GenericDataModel>(reader: GenericDatabaseReader<DM>) {
	const stats = { gets: 0, duplicateGets: 0, queries: 0, rows: 0, policies: 0 }
	const ids = new Set<string>()
	let enabled = true
	function query<Source extends object>(source: Source): Source {
		return new Proxy(source, {
			get(target, key) {
				const value = Reflect.get(target, key)
				if (typeof value !== 'function') return value
				if (key === Symbol.asyncIterator)
					return () => {
						const iterator = value.call(target)
						return {
							next: async () => {
								const row = await iterator.next()
								if (!row.done && enabled) stats.rows++
								return row
							},
							return: () => iterator.return(),
						}
					}
				if (
					key === 'withIndex' ||
					key === 'withSearchIndex' ||
					key === 'order' ||
					key === 'fullTableScan'
				)
					return (...args: unknown[]) => query(value.apply(target, args))
				if (key === 'paginate')
					return async (...args: unknown[]) => {
						const result = await value.apply(target, args)
						if (enabled) stats.rows += result.page.length
						return result
					}
				return value.bind(target)
			},
		})
	}
	const db: GenericDatabaseReader<DM> = {
		...reader,
		get: (...args: Parameters<typeof reader.get>) => {
			if (enabled) {
				stats.gets++
				const id = args.join('/')
				if (ids.has(id)) stats.duplicateGets++
				ids.add(id)
			}
			return reader.get(...args)
		},
		query: (table) => {
			if (enabled) stats.queries++
			return query(reader.query(table))
		},
		normalizeId: reader.normalizeId.bind(reader),
	}
	return {
		db,
		rule: async () => {
			if (enabled) stats.policies++
			return true
		},
		counts: () => {
			enabled = false
			return { ...stats }
		},
	}
}

async function pagination(mode: string, size: number) {
	const { schema, relations } = fixture()
	const { createTest } = defineTestApp({ schema }).defineModules({})
	const app = createTest()
	await app.run(async ({ db }) => {
		const grand = await db.insert('entity0', { ...fields(0), secret: 'private' })
		const parents = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				db.insert('entity1', { ...fields(i), secret: 'private', parentId: grand }),
			),
		)
		for (let i = 0; i < 2400; i++) {
			const row = await db.insert('entity2', {
				...fields(i),
				secret: 'private',
				parentId: parents[i % parents.length],
			})
			if (mode === 'relations' && i < 120)
				await db.insert('entity3', { ...fields(i), secret: 'private', parentId: row })
		}
	})
	const engine = createQueryEngine({ schema, relations, cursor })
	return (run: Run) =>
		app.run(async ({ db }) => {
			const meter = instrument(db)
			const rules = {
				entity0: { read: meter.rule },
				entity1: { read: meter.rule },
				entity2: { read: meter.rule },
				entity3: { read: meter.rule },
			}
			const args = { cursor: null, numItems: size, order: 'asc' as const }
			const invoke = () => {
				const context = {
					db: registerQueryReader(meter.db, meter.db, { scope, rules, defaultPolicy: 'deny' }),
				}
				const rows = engine(context).entity2
				if (mode === 'relations') return rows.orderBy('by_amount').with(selection).paginate(args)
				if (mode === 'search')
					return rows.search('search_title', 'Benchmark').paginate({
						cursor: null,
						numItems: size,
						filters: status,
					})
				if (mode === 'merge')
					return rows.orderBy('by_status_amount').paginate({ ...args, filters: fanout })
				if (mode === 'indexed')
					return rows.orderBy('by_status_amount').paginate({ ...args, filters: several })
				const filters = mode === 'zero' ? undefined : mode === 'one' ? status : several
				return rows.orderBy('by_amount').paginate({ ...args, filters })
			}
			await run(invoke, meter.counts)
		})
}

function cursorTransport(mode: string) {
	const codec = createCursorCodec(cursor)
	const binding: CursorBinding = {
		table: 'entity2',
		index: 'by_amount',
		order: 'asc',
		clientFilters: several,
		serverFilters: { scope, selection },
		relationPath: [],
		principal: 'bench',
		tenant: 'bench',
		policyVersion: '1',
		engineVersion: 'scalar-1',
		registryVersion: 'representative-digest',
	}
	const raw = JSON.stringify(['77', 77, 'bench-row-77'])
	if (mode === 'seal') return noTransaction(() => codec.seal(raw, binding))
	// Roundtrip isolates one open plus one seal without prewarming either.
	return noTransaction(() => codec.open(codec.seal(raw, binding), binding))
}

function effects(mode: string) {
	const input = z.object({ count: z.number() })
	const result = z.number()
	const value = { count: 4 }
	const host = { user: 'bench' }
	const handler = (args: typeof value) => args.count + 1
	if (mode === 'direct') return noTransaction(async () => handler(value))
	const observability = {
		enabled: true,
		classifyError: () => ({ outcome: 'failed' as const, errorCode: 'BENCH' }),
		emit: () => {},
	}
	const context = (current: typeof host) => current
	const guard = () => {}
	const checkPermission = () => {}
	if (mode === 'query') {
		const queries = createEffectQuery({
			context,
			checkPermission,
			observability,
			operations: ({ query }) => ({
				read: query({ input, result, permission: 'read', guard, handler }),
			}),
		})
		return noTransaction(() => Effect.runPromise(queries.exec('read', value, host)))
	}
	const create = bindEffectCommand({
		checkPermission,
		observability: new Observability(observability),
		writeAudit: (_host: typeof host) => {
			if (mode === 'command-folded')
				throw new Error('Nested command unexpectedly wrote its own audit')
		},
	})
	const commands = create({
		context,
		operations: ({ command }) => ({
			write: command({
				input,
				result,
				handler,
				guard,
				permission: 'write',
				classification: 'business',
				aggregates: ['row'],
				audit: () => ({
					operation: 'write',
					actorId: 'bench',
					aggregate: { type: 'row', id: 'id' },
				}),
			}),
		}),
	})
	return noTransaction(() => {
		const command = commands.exec('write', value, host)
		const execution =
			mode === 'command-folded' ? enterRequestScope('outer', true, () => command) : command
		return Effect.runPromise(execution)
	})
}

function planning() {
	const { schema, relations } = fixture()
	const planner = createPlanner(schema, relations)
	return noTransaction(async () => {
		const plan = planner.plan(
			'entity2',
			{ cursor: null, numItems: 100, filters: several },
			[],
			[],
			'by_status_amount',
		)
		return planner.registryVersion({
			root: 'entity2',
			path: [],
			selection: {},
			groups: { relations: {} },
			filters: [plan.residual],
		})
	})
}

export async function setup(scenario: string) {
	const [suite, mode, size] = scenario.split('/')
	switch (suite) {
		case 'authQuery':
			return registration(mode!, Number(size), false)
		case 'authMutation':
			return registration(mode!, Number(size), true)
		case 'page':
			return pagination(mode!, Number(size))
		case 'cursor':
			return cursorTransport(mode!)
		case 'plan':
			return planning()
		case 'effect':
			return effects(mode!)
		default:
			throw new Error(`Unknown scenario: ${scenario}`)
	}
}
