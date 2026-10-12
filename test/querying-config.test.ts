import { afterEach, describe, expect, test, vi } from 'vite-plus/test'
import { createQueryEngine } from '../src/querying'
import { CursorConfigurationError } from '../src/querying/cursors'
import {
	cursor,
	declarations,
	harness,
	managed,
	observed,
	scope,
	seed,
} from './fixture-querying/scalar'

const keyHex = '07'.repeat(64)
function environment() {
	vi.stubEnv('CVX_QUERY_CURSOR_KEYS_JSON', JSON.stringify({ current: keyHex }))
	vi.stubEnv('CVX_QUERY_CURSOR_CURRENT_KEY_ID', 'current')
}
afterEach(() => vi.unstubAllEnvs())

describe('query engine configuration', () => {
	test('simple setup traverses two tables across independent engine instances and requests', async () => {
		environment()
		const f = harness()
		const rows = await seed(f, 7)
		const permissions = await f.t.run(async (ctx) => {
			const ids = []
			for (let i = 0; i < 5; i++)
				ids.push(await ctx.db.insert('permissions', { allowed: true, tenant: 'one' }))
			return ids
		})
		const other = declarations()
		const engines = [
			createQueryEngine({ schema: f.schema, relations: f.relations }),
			createQueryEngine({ schema: other.schema, relations: other.relations }),
		]
		for (const table of ['tasks', 'permissions'] as const) {
			const ids = []
			let token: string | null = null
			for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
				const page = await f.t.run(async (ctx) => {
					const result = await engines[pageNumber % 2](managed(ctx.db))[table].paginate({
						numItems: 2,
						cursor: token,
					})
					return {
						ids: result.page.map((row) => row._id),
						continueCursor: result.continueCursor,
						isDone: result.isDone,
					}
				})
				ids.push(...page.ids)
				expect(page.continueCursor).toMatch(/^pc\.1\.current\.[0-9a-f]+$/)
				if (page.isDone) break
				token = page.continueCursor
			}
			expect(ids).toEqual(table === 'tasks' ? rows.map((row) => row._id) : permissions)
		}
	})

	test('creation and binding need no env; first paginate reads the later configured env', async () => {
		vi.stubEnv('CVX_QUERY_CURSOR_KEYS_JSON', undefined)
		vi.stubEnv('CVX_QUERY_CURSOR_CURRENT_KEY_ID', undefined)
		const f = harness()
		await seed(f, 2)
		const engine = createQueryEngine({ schema: f.schema, relations: f.relations })
		await f.t.run(async (ctx) => {
			const q = engine(managed(ctx.db)).tasks.where({ tenant: 'one' })
			environment()
			const first = await q.paginate({ numItems: 1, cursor: null })
			expect(first.page).toHaveLength(1)
			// A successful load snapshots keys for this engine, like an explicit codec.
			vi.stubEnv('CVX_QUERY_CURSOR_KEYS_JSON', 'malformed')
			const next = await q.paginate({ numItems: 1, cursor: first.continueCursor })
			expect(next.page).toHaveLength(1)
		})
	})

	test('environment current key selects new seals while retained keys resume old cursors', async () => {
		environment()
		const f = harness()
		await seed(f, 3)
		const old = createQueryEngine({ schema: f.schema, relations: f.relations })
		const rotated = createQueryEngine({ schema: f.schema, relations: f.relations })
		const first = await f.t.run((ctx) =>
			old(managed(ctx.db)).tasks.paginate({ numItems: 1, cursor: null }),
		)
		vi.stubEnv(
			'CVX_QUERY_CURSOR_KEYS_JSON',
			JSON.stringify({
				current: keyHex,
				next: 'AB'.repeat(64),
			}),
		)
		vi.stubEnv('CVX_QUERY_CURSOR_CURRENT_KEY_ID', 'next')
		const next = await f.t.run((ctx) =>
			rotated(managed(ctx.db)).tasks.paginate({ numItems: 1, cursor: first.continueCursor }),
		)
		expect(next.page).toHaveLength(1)
		expect(next.continueCursor).toMatch(/^pc\.1\.next\./)
		await f.t.run(async (ctx) => {
			const o = observed(ctx.db)
			await expect(
				old(managed(o.raw)).tasks.paginate({ numItems: 1, cursor: next.continueCursor }),
			).rejects.toThrow('Invalid cursor')
			expect(o.counts.next).toBe(0)
		})
	})

	test.each([
		[undefined, undefined],
		[JSON.stringify({ current: keyHex }), undefined],
		[undefined, 'current'],
		['secret malformed JSON', 'current'],
		['null', 'current'],
		['[]', 'current'],
		['"secret"', 'current'],
		['{}', 'current'],
		[JSON.stringify({ current: '07'.repeat(63) }), 'current'],
		[JSON.stringify({ current: 'zz'.repeat(64) }), 'current'],
		[JSON.stringify({ current: 7 }), 'current'],
		[JSON.stringify({ current: keyHex, stale: 'secret malformed key' }), 'current'],
		[JSON.stringify({ current: keyHex }), 'missing'],
		[JSON.stringify({ 'bad.id': keyHex }), 'bad.id'],
	])(
		'invalid env case %# fails redacted before query construction or reads',
		async (keys, current) => {
			vi.stubEnv('CVX_QUERY_CURSOR_KEYS_JSON', keys)
			vi.stubEnv('CVX_QUERY_CURSOR_CURRENT_KEY_ID', current)
			const f = harness()
			const engine = createQueryEngine({ schema: f.schema, relations: f.relations })
			await f.t.run(async (ctx) => {
				const o = observed(ctx.db)
				let queries = 0
				const raw: typeof o.raw = {
					...o.raw,
					query: (table) => {
						queries++
						return o.raw.query(table)
					},
				}
				const q = engine(managed(raw)).tasks
				await expect(q.paginate({ numItems: 1, cursor: null })).rejects.toThrow(
					CursorConfigurationError,
				)
				await expect(q.paginate({ numItems: 1, cursor: null })).rejects.toThrow(
					'Invalid cursor server configuration',
				)
				expect(queries).toBe(0)
				expect(o.counts).toEqual({ next: 0, returned: 0, ranges: 0, gets: 0, closes: 0 })
				// Failed initialization does not lock the engine into a bad configuration.
				environment()
				expect((await q.paginate({ numItems: 1, cursor: null })).isDone).toBe(true)
			})
		},
	)

	test('environment cursors reject tampering and filter/table replay before native reads', async () => {
		environment()
		const f = harness()
		await seed(f, 7)
		const engine = createQueryEngine({ schema: f.schema, relations: f.relations })
		const first = await f.t.run((ctx) =>
			engine(managed(ctx.db)).tasks.paginate({
				numItems: 1,
				cursor: null,
				filters: { department: 'a' },
			}),
		)
		await f.t.run(async (ctx) => {
			const o = observed(ctx.db)
			let queries = 0
			const raw: typeof o.raw = {
				...o.raw,
				query: (table) => {
					queries++
					return o.raw.query(table)
				},
			}
			const q = engine(managed(raw))
			const token = first.continueCursor
			const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
			for (const args of [
				{ numItems: 1, cursor: tampered, filters: { department: 'a' } },
				{ numItems: 1, cursor: token, filters: { department: 'b' } },
				{ numItems: 1, cursor: null, endCursor: tampered, filters: { department: 'a' } },
			])
				await expect(q.tasks.paginate(args)).rejects.toThrow('Invalid cursor')
			await expect(q.permissions.paginate({ numItems: 1, cursor: token })).rejects.toThrow(
				'Invalid cursor',
			)
			expect(queries).toBe(0)
			expect(o.counts).toEqual({ next: 0, returned: 0, ranges: 0, gets: 0, closes: 0 })
		})
	})

	test('second argument controls codec, ceilings, budgets and binding versions; legacy still resumes', async () => {
		vi.stubEnv('CVX_QUERY_CURSOR_KEYS_JSON', 'malformed')
		const f = harness()
		const rows = await seed(f, 3)
		const options = { cursor, maxPageSize: 2, policyVersion: 'p2', engineVersion: 'e2' }
		const engine = createQueryEngine({ schema: f.schema, relations: f.relations }, options)
		const legacy = createQueryEngine({ schema: f.schema, relations: f.relations, ...options })
		await f.t.run(async (ctx) => {
			const q = engine(managed(ctx.db)).tasks
			await expect(q.paginate({ numItems: 3, cursor: null })).rejects.toThrow(
				'Page size exceeds central ceiling',
			)
			const first = await q.paginate({ numItems: 1, cursor: null })
			const next = await legacy(managed(ctx.db)).tasks.paginate({
				numItems: 2,
				cursor: first.continueCursor,
			})
			expect([...first.page, ...next.page].map((r) => r._id)).toEqual(rows.map((r) => r._id))
			for (const changed of [{ policyVersion: 'other' }, { engineVersion: 'other' }]) {
				const o = observed(ctx.db)
				const other = createQueryEngine(
					{ schema: f.schema, relations: f.relations },
					{ ...options, ...changed },
				)
				await expect(
					other(managed(o.raw)).tasks.paginate({ numItems: 1, cursor: first.continueCursor }),
				).rejects.toThrow('Invalid cursor')
				expect(o.counts.next).toBe(0)
			}
			const limited = createQueryEngine(
				{ schema: f.schema, relations: f.relations },
				{ cursor, budgets: { rawCandidates: 1 } },
			)
			const o = observed(ctx.db)
			await limited(managed(o.raw)).tasks.paginate({ numItems: 3, cursor: null })
			expect(o.counts.returned).toBeLessThanOrEqual(1)
		})
	})

	test('explicit codec errors still fail during creation', () => {
		const f = declarations()
		const invalid = { ...cursor, keys: { test: new Uint8Array(63) } }
		expect(() =>
			createQueryEngine({ schema: f.schema, relations: f.relations }, { cursor: invalid }),
		).toThrow(CursorConfigurationError)
		expect(() =>
			createQueryEngine({ schema: f.schema, relations: f.relations, cursor: invalid }),
		).toThrow(CursorConfigurationError)
	})

	test('second argument takes precedence over legacy fields and supports a trusted adapter', async () => {
		vi.stubEnv('CVX_QUERY_CURSOR_KEYS_JSON', 'malformed')
		const f = harness()
		await seed(f, 2)
		const legacyConfig = {
			schema: f.schema,
			relations: f.relations,
			cursor: { ...cursor, keys: { test: new Uint8Array(1) } },
			maxPageSize: 0,
			budgets: { rawCandidates: -1 },
			policyVersion: '',
			engineVersion: 'legacy',
			trustedAdapter: () => null,
		}
		const engine = createQueryEngine(legacyConfig, {
			cursor,
			maxPageSize: 2,
			budgets: { rawCandidates: 10 },
			policyVersion: 'p2',
			engineVersion: 'e2',
			trustedAdapter: (ctx) => ({ reader: ctx.db, scope, rules: {}, defaultPolicy: 'allow' }),
		})
		await f.t.run(async (ctx) => {
			const o = observed(ctx.db)
			const first = await engine({ db: o.raw }).tasks.paginate({ numItems: 1, cursor: null })
			expect(first.page).toHaveLength(1)
			const equivalent = createQueryEngine(
				{ schema: f.schema, relations: f.relations },
				{
					cursor,
					policyVersion: 'p2',
					engineVersion: 'e2',
				},
			)
			const next = await equivalent(managed(o.raw)).tasks.paginate({
				numItems: 1,
				cursor: first.continueCursor,
			})
			expect(next.page).toHaveLength(1)
			expect(next.page[0]._id).not.toBe(first.page[0]._id)
		})
	})
})
