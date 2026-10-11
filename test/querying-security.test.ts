import { describe, expect, it } from 'vite-plus/test'
import { getDocumentSize, type GenericId } from 'convex/values'
import type {
	GenericDataModel,
	GenericDatabaseReader,
	GenericTableInfo,
	QueryInitializer,
	GenericDocument,
} from 'convex/server'
import type { SecurityPolicyContext } from '../src/auth'
import type { Rules } from '../src/tenancy'
import {
	createManagedSecurity,
	registerQueryReader,
	MAX_DOCUMENT_BYTES,
} from '../src/querying/security'

function id<Table extends string>(value: string): GenericId<Table> {
	// SAFETY: these table-prefixed fixture IDs are recognized by the instrumented normalizeId.
	return value as GenericId<Table>
}

function fixture(rules?: Rules<SecurityPolicyContext<GenericDataModel>, GenericDataModel>) {
	const rows = new Map<string, GenericDocument & { _id: string; _creationTime: number }>([
		['tasks:1', { _id: 'tasks:1', _creationTime: 1, tenant: 'one' }],
		['tasks:2', { _id: 'tasks:2', _creationTime: 2, tenant: 'two' }],
	])
	let reads = 0
	const raw: GenericDatabaseReader<GenericDataModel> = {
		get: async (table: string, id?: string) => {
			reads++
			return rows.get(id ?? table) ?? null
		},
		normalizeId: <Table extends string>(table: Table, value: string) =>
			value.startsWith(`${table}:`) ? id<Table>(value) : null,
		query: (table: string) => {
			const values = [...rows.values()].filter((row) => row._id.startsWith(`${table}:`))
			const unsupported = (): never => {
				throw new Error('unsupported fixture operation')
			}
			const initializer: QueryInitializer<GenericTableInfo> = {
				filter: unsupported,
				order: () => initializer,
				withSearchIndex: unsupported,
				collect: unsupported,
				take: unsupported,
				first: unsupported,
				unique: unsupported,
				paginate: unsupported,
				fullTableScan: () => initializer,
				withIndex: () => initializer,
				[Symbol.asyncIterator]: async function* () {
					for (const row of values) {
						reads++
						yield row
					}
					reads++
				},
			}
			return initializer
		},
		system: {
			get: () => {
				throw new Error('system not used')
			},
			query: () => {
				throw new Error('system not used')
			},
			normalizeId: () => null,
		},
	}
	const scope = {
		mode: 'authenticated' as const,
		principal: 'u1',
		organization: 'one',
		tenant: 'one',
		role: 'reader',
	}
	const db = registerQueryReader(raw, raw, {
		scope,
		rules: rules ?? { tasks: { read: async (_ctx, doc) => doc.tenant === 'one' } },
		defaultPolicy: 'deny',
	})
	const managed = createManagedSecurity({ tables: ['tasks', 'unruled'], policyVersion: '1' })
	return { raw, db, scope, managed, rows, reads: () => reads }
}

describe('managed query authority', () => {
	it('retains independent immutable authority across spreads and shared raw readers', async () => {
		const f = fixture()
		const second = registerQueryReader(f.raw, f.raw, {
			scope: { ...f.scope, principal: 'u2', tenant: 'two' },
			rules: { tasks: { read: async (_ctx, doc) => doc.tenant === 'two' } },
			defaultPolicy: 'deny',
		})
		const context = { db: f.db }
		const one = f.managed({ ...context, tenant: 'two', actor: { userId: 'forged' } })
		const two = f.managed({ db: second })
		expect(one.scope.tenant).toBe('one')
		expect(one.scope.principal).toBe('u1')
		expect(await one.db.get('tasks', id<'tasks'>('tasks:1'))).not.toBeNull()
		expect(await one.db.get('tasks', id<'tasks'>('tasks:2'))).toBeNull()
		expect(await two.db.get('tasks', id<'tasks'>('tasks:2'))).not.toBeNull()
		expect(Object.keys(f.db).sort()).toEqual(['get', 'normalizeId', 'query', 'system'])
	})
	it('rejects unknown/native/wrapper contexts without examining wrapper fields', () => {
		const f = fixture()
		expect(() => f.managed({ db: f.raw })).toThrow(/UNMANAGED_QUERY_CONTEXT/)
		const wrapper = Object.assign({}, f.raw, { db: f.raw })
		expect(() => f.managed({ db: wrapper })).toThrow(/UNMANAGED_QUERY_CONTEXT/)
	})
	it('counts denied and missing reads and memoizes within one request', async () => {
		const f = fixture()
		const request = f.managed({ db: f.db })
		expect(await request.db.get('tasks', id<'tasks'>('tasks:2'))).toBeNull()
		expect(await request.db.get('tasks', id<'tasks'>('tasks:missing'))).toBeNull()
		await request.db.get('tasks', id<'tasks'>('tasks:2'))
		expect(request.counters.readOperations).toBe(2)
		expect(request.counters.indexRanges).toBe(2)
		expect(f.reads()).toBe(2)
	})
	it('fails before fetching when one maximum-size document cannot be reserved', async () => {
		const f = fixture()
		const request = f.managed({ db: f.db }, { documentBytes: MAX_DOCUMENT_BYTES - 1 })
		await expect(request.db.get('tasks', id<'tasks'>('tasks:1'))).rejects.toThrow(
			/MANAGED_READ_BUDGET/,
		)
		expect(f.reads()).toBe(0)
	})
	it('allows only explicit centrally trusted adapters for a native reader', async () => {
		const f = fixture()
		const trusted = createManagedSecurity({
			tables: ['tasks'],
			policyVersion: 'trusted',
			trustedAdapter: (ctx) =>
				ctx.db === f.raw
					? {
							reader: f.raw,
							scope: { ...f.scope, mode: 'trusted' },
							rules: {},
							defaultPolicy: 'allow',
						}
					: null,
		})
		expect(await trusted({ db: f.raw }).db.get('tasks', id<'tasks'>('tasks:2'))).not.toBeNull()
	})
	it('uses exact registered defaults and denies unruled/unknown-table get paths', async () => {
		const f = fixture()
		f.rows.set('unruled:1', { _id: 'unruled:1', _creationTime: 1 })
		const r = f.managed({ db: f.db })
		expect(await r.db.get(id<'unruled'>('unruled:1'))).toBeNull()
		expect(r.counters.readOperations).toBe(1)
		expect(await r.db.get(id<'unknown'>('unknown:1'))).toBeNull()
		expect(r.counters.readOperations).toBe(1)
		await expect(r.db.get('unknown', id<'unknown'>('unknown:1'))).rejects.toThrow(
			/UNSUPPORTED_MANAGED_READ/,
		)
		expect(() => r.db.system.query('_storage')).toThrow(/UNSUPPORTED_MANAGED_READ/)
		expect(() => r.db.normalizeId('unknown', 'unknown:1')).toThrow(/UNSUPPORTED_MANAGED_READ/)
		expect(r.db.normalizeId('tasks', 'tasks:1')).toBe('tasks:1')
	})
})

describe('shared policy and traversal costs', () => {
	it('authorizes unrelated policy dependencies and shares their reads with targets', async () => {
		const f = fixture({
			tasks: {
				read: async ({ db }, doc) =>
					doc._id === 'tasks:2' || !!(await db.get('tasks', id<'tasks'>('tasks:2'))),
			},
		})
		const r = f.managed({ db: f.db })
		expect(await r.db.get('tasks', id<'tasks'>('tasks:1'))).not.toBeNull()
		expect(r.counters.readOperations).toBe(2)
		await r.db.get('tasks', id<'tasks'>('tasks:2'))
		expect(r.counters.readOperations).toBe(2)
		expect(r.counters.memoEntries).toBe(2)
		const limited = f.managed({ db: f.db }, { readOperations: 1 })
		await expect(limited.db.get('tasks', id<'tasks'>('tasks:1'))).rejects.toThrow(
			/MANAGED_READ_BUDGET/,
		)
	})
	it('does not bypass dependency denials or default deny', async () => {
		const f = fixture({
			tasks: {
				read: async ({ db }, doc) =>
					doc._id === 'tasks:1' && !!(await db.get('tasks', id<'tasks'>('tasks:2'))),
			},
		})
		const r = f.managed({ db: f.db })
		expect(await r.db.get('tasks', id<'tasks'>('tasks:1'))).toBeNull()
		expect(r.counters.readOperations).toBe(2)
	})
	it.each(['self', 'cycle'] as const)(
		'fails deterministically on a %s policy dependency',
		async (mode) => {
			const f = fixture({
				tasks: {
					read: async ({ db }, doc) => {
						const targetId =
							mode === 'self' ? doc._id : doc._id === 'tasks:1' ? 'tasks:2' : 'tasks:1'
						return !!(await db.get('tasks', id<'tasks'>(String(targetId))))
					},
				},
			})
			const r = f.managed({ db: f.db })
			await expect(r.db.get('tasks', id<'tasks'>('tasks:1'))).rejects.toThrow(/POLICY_RECURSION/)
			expect(r.counters.readOperations).toBe(mode === 'self' ? 1 : 2)
			expect(r.counters.documentBytesReserved).toBe(0)
		},
	)
	it('does not deadlock mutually dependent concurrent roots', async () => {
		const f = fixture({
			tasks: {
				read: async ({ db }, doc) =>
					!!(await db.get('tasks', id<'tasks'>(doc._id === 'tasks:1' ? 'tasks:2' : 'tasks:1'))),
			},
		})
		const r = f.managed({ db: f.db })
		const results = await Promise.allSettled([
			r.db.get('tasks', id<'tasks'>('tasks:1')),
			r.db.get('tasks', id<'tasks'>('tasks:2')),
		])
		expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
		for (const result of results)
			if (result.status === 'rejected') expect(result.reason.message).toBe('POLICY_RECURSION')
	})
	it.each(['first', 'unique', 'take', 'iterator', 'leaf'] as const)(
		'meters %s consumption, including denied raw rows',
		async (method) => {
			const f = fixture()
			const r = f.managed({ db: f.db })
			const q = r.db.query('tasks').fullTableScan().order('asc')
			let docs: (GenericDocument | null)[]
			if (method === 'first') docs = [await q.first()]
			else if (method === 'unique') docs = [await q.unique()]
			else if (method === 'take') docs = await q.take(2)
			else {
				docs = []
				for await (const doc of method === 'leaf'
					? r.leafQuery('tasks').withIndex('by_creation_time')
					: q)
					docs.push(doc)
			}
			expect(docs.map((doc) => doc?._id)).toEqual(
				method === 'leaf' ? ['tasks:1', 'tasks:2'] : ['tasks:1'],
			)
			expect(r.counters.rawCandidates).toBe(method === 'first' ? 1 : 2)
			expect(r.counters.readOperations).toBe(method === 'first' ? 1 : 3)
			expect(r.counters.indexRanges).toBe(1)
			expect(r.counters.documentBytesReserved).toBe(0)
		},
	)
	it.each(['collect', 'paginate', 'filter', 'withSearchIndex'] as const)(
		'fails closed for unsupported managed %s',
		(method) => {
			const f = fixture()
			const r = f.managed({ db: f.db })
			const q = r.db.query('tasks')
			const operations = {
				collect: () => q.collect(),
				paginate: () => q.paginate({ numItems: 1, cursor: null }),
				filter: () => q.filter((b) => b.eq(b.field('tenant'), 'one')),
				withSearchIndex: () => q.withSearchIndex('search', (b) => b.search('tenant', 'one')),
			}
			expect(operations[method]).toThrow(/UNSUPPORTED_MANAGED_READ/)
			expect(f.reads()).toBe(0)
		},
	)
	it('shares parent/junction/target/policy leaf reservations and expansion ceilings', () => {
		const f = fixture()
		const r = f.managed({ db: f.db }, { readOperations: 2, indexRanges: 1, fanout: 2, depth: 2 })
		r.openRange()
		expect(() => r.openRange()).toThrow(/MANAGED_READ_BUDGET/)
		r.expand(1, 2)
		expect(() => r.expand(1)).toThrow(/MANAGED_READ_BUDGET/)
		expect(() => r.expand(3, 0)).toThrow(/MANAGED_READ_BUDGET/)
		r.reserveLeaf().settle(null)
		r.reserveLeaf().settle(null)
		expect(() => r.reserveLeaf()).toThrow(/MANAGED_READ_BUDGET/)
	})
	it('limits policy recursion depth and memo allocations before more leaf reads', async () => {
		const f = fixture({
			tasks: {
				read: async ({ db }, doc) =>
					doc._id === 'tasks:2' || !!(await db.get('tasks', id<'tasks'>('tasks:2'))),
			},
		})
		for (const lower of [{ depth: 1 }, { memoEntries: 1 }]) {
			const r = f.managed({ db: f.db }, lower)
			await expect(r.db.get('tasks', id<'tasks'>('tasks:1'))).rejects.toThrow(/MANAGED_READ_BUDGET/)
			expect(r.counters.readOperations).toBe(1)
		}
	})
})

describe('conservative managed document payload reservations', () => {
	it.each(['readOperations', 'memoEntries'] as const)(
		'reserves %s before a concurrent actual fetch',
		async (limit) => {
			const f = fixture()
			const original = f.raw.get
			const gate = Promise.withResolvers<void>()
			let attempts = 0
			f.raw.get = async (...args: Parameters<typeof original>) => {
				attempts++
				await gate.promise
				return original(...args)
			}
			const r = f.managed({ db: f.db }, { [limit]: 1 })
			const first = r.db.get('tasks', id<'tasks'>('tasks:1'))
			try {
				await expect(r.db.get('tasks', id<'tasks'>('tasks:2'))).rejects.toThrow(
					/MANAGED_READ_BUDGET/,
				)
				expect(attempts).toBe(1)
				expect(r.counters.readOperations).toBe(1)
				expect(r.counters.memoEntries).toBe(1)
			} finally {
				gate.resolve()
			}
			expect(await first).not.toBeNull()
			expect(f.reads()).toBe(1)
			expect(r.counters.rawCandidates).toBe(1)
			expect(r.counters.memoEntries).toBe(1)
			expect(r.counters.documentBytesReserved).toBe(0)
		},
	)
	it.each(['early-close', 'next-error', 'quota', 'terminal'] as const)(
		'closes the leaf iterator and settles reservations on %s',
		async (mode) => {
			const f = fixture()
			const original = f.raw.query
			let nextCalls = 0
			let returnCalls = 0
			f.raw.query = (table) => ({
				...original(table),
				[Symbol.asyncIterator]: () => ({
					async next() {
						nextCalls++
						if (mode === 'terminal') return { done: true as const, value: undefined }
						if (nextCalls === 1) return { done: false as const, value: f.rows.get('tasks:1')! }
						throw new Error('iterator next failed')
					},
					async return() {
						returnCalls++
						return { done: true as const, value: undefined }
					},
				}),
			})
			const r = f.managed({ db: f.db }, mode === 'quota' ? { rawCandidates: 1 } : {})
			const q = r.db.query('tasks')
			if (mode === 'quota') {
				const consume = async () => {
					const documents = []
					for await (const document of q) documents.push(document)
					return documents
				}
				await expect(consume()).rejects.toThrow('MANAGED_READ_BUDGET')
			} else if (mode === 'next-error')
				await expect(q.take(2)).rejects.toThrow('iterator next failed')
			else expect(await q.first()).toEqual(mode === 'terminal' ? null : f.rows.get('tasks:1'))
			expect(nextCalls).toBe(mode === 'next-error' ? 2 : 1)
			expect(returnCalls).toBe(1)
			expect(r.counters.readOperations).toBe(mode === 'next-error' ? 2 : 1)
			expect(r.counters.rawCandidates).toBe(mode === 'terminal' ? 0 : 1)
			expect(r.counters.documentBytesReserved).toBe(0)
			expect(r.counters.documentBytesObserved).toBe(
				mode === 'terminal' ? 0 : getDocumentSize(f.rows.get('tasks:1')!),
			)
		},
	)
	it('reserves raw-candidate slots atomically across concurrent leaf calls', async () => {
		const f = fixture()
		const r = f.managed({ db: f.db }, { rawCandidates: 1 })
		const first = r.db.get('tasks', id<'tasks'>('tasks:1'))
		await expect(r.db.get('tasks', id<'tasks'>('tasks:2'))).rejects.toThrow(/MANAGED_READ_BUDGET/)
		await first
		expect(f.reads()).toBe(1)
		expect(r.counters.rawCandidates).toBe(1)
	})
	it('reserves concurrent calls atomically before await and refunds exact UTF8/binary size', async () => {
		const f = fixture()
		f.rows.set('tasks:1', {
			_id: 'tasks:1',
			_creationTime: 1,
			tenant: 'one',
			text: '🌻',
			bytes: new Uint8Array([1, 2, 3]).buffer,
		})
		const r = f.managed({ db: f.db }, { documentBytes: MAX_DOCUMENT_BYTES })
		const pending = r.db.get('tasks', id<'tasks'>('tasks:1'))
		expect(r.counters.documentBytesReserved).toBe(MAX_DOCUMENT_BYTES)
		await expect(r.db.get('tasks', id<'tasks'>('tasks:2'))).rejects.toThrow(/MANAGED_READ_BUDGET/)
		expect(f.reads()).toBe(1)
		const doc = await pending
		expect(r.counters.documentBytesObserved).toBe(getDocumentSize(doc!))
		expect(r.counters.documentBytesReserved).toBe(0)
		await expect(r.db.get('tasks', id<'tasks'>('tasks:2'))).rejects.toThrow(/MANAGED_READ_BUDGET/)
	})
	it('allows exact 1MiB documents and rejects a result outside the legal reservation bound', async () => {
		for (const extra of [0, 1]) {
			const f = fixture()
			const doc = { _id: 'tasks:1', _creationTime: 1, tenant: 'one', bytes: new ArrayBuffer(0) }
			doc.bytes = new ArrayBuffer(MAX_DOCUMENT_BYTES - getDocumentSize(doc) + extra)
			f.rows.set('tasks:1', doc)
			const r = f.managed({ db: f.db })
			if (extra)
				await expect(r.db.get('tasks', id<'tasks'>('tasks:1'))).rejects.toThrow(
					/MANAGED_READ_BUDGET/,
				)
			else {
				await r.db.get('tasks', id<'tasks'>('tasks:1'))
				expect(r.counters.documentBytesObserved).toBe(MAX_DOCUMENT_BYTES)
			}
			expect(r.counters.documentBytesReserved).toBe(0)
		}
	})
	it('releases error/missing reservations while retaining operation counts', async () => {
		const f = fixture()
		const original = f.raw.get
		let fail = true
		f.raw.get = async (...args: Parameters<typeof original>) => {
			if (fail) throw new Error('leaf failed')
			return original(...args)
		}
		const r = f.managed({ db: f.db }, { documentBytes: MAX_DOCUMENT_BYTES, rawCandidates: 1 })
		await expect(r.db.get('tasks', id<'tasks'>('tasks:1'))).rejects.toThrow('leaf failed')
		fail = false
		expect(await r.db.get('tasks', id<'tasks'>('tasks:missing'))).toBeNull()
		expect(r.counters.readOperations).toBe(2)
		expect(r.counters.indexRanges).toBe(2)
		expect(r.counters.documentBytesReserved).toBe(0)
		expect(r.counters.documentBytesObserved).toBe(0)
		expect(await r.db.get('tasks', id<'tasks'>('tasks:1'))).not.toBeNull()
		expect(r.counters.readOperations).toBe(3)
		expect(r.counters.rawCandidates).toBe(1)
		expect(f.reads()).toBe(2)
	})
	it('refunds terminal iterator candidate reservations before a later actual get', async () => {
		const f = fixture()
		const r = f.managed({ db: f.db }, { rawCandidates: 1 })
		expect(await r.db.query('unruled').first()).toBeNull()
		expect(r.counters.readOperations).toBe(1)
		expect(r.counters.rawCandidates).toBe(0)
		expect(await r.db.get('tasks', id<'tasks'>('tasks:1'))).not.toBeNull()
		expect(r.counters.readOperations).toBe(2)
		expect(r.counters.rawCandidates).toBe(1)
		expect(f.reads()).toBe(2)
	})
	it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid central/request ceilings: %s', (value) => {
		const f = fixture()
		expect(() =>
			createManagedSecurity({
				tables: ['tasks'],
				policyVersion: '1',
				budgets: { readOperations: value },
			}),
		).toThrow(/Invalid managed read budgets/)
		expect(() => f.managed({ db: f.db }, { readOperations: value })).toThrow(
			/Invalid managed read budgets/,
		)
	})
	it('request overrides cannot increase central ceilings', () => {
		const f = fixture()
		const managed = createManagedSecurity({
			tables: ['tasks'],
			policyVersion: '1',
			budgets: { readOperations: 1 },
		})
		expect(managed({ db: f.db }, { readOperations: 100 }).budgets.readOperations).toBe(1)
	})
	it('keeps authority, rules and central settings independent of later caller mutation', async () => {
		const f = fixture()
		const rules: Rules<SecurityPolicyContext<GenericDataModel>, GenericDataModel> = {
			tasks: { read: async () => true },
		}
		const db = registerQueryReader(f.raw, f.raw, { scope: f.scope, rules, defaultPolicy: 'deny' })
		const settings = {
			tables: ['tasks'],
			policyVersion: 'original',
			budgets: { readOperations: 1 },
		}
		const managed = createManagedSecurity(settings)
		rules.tasks!.read = async () => false
		f.scope.tenant = 'changed'
		settings.tables.push('unruled')
		settings.policyVersion = 'changed'
		settings.budgets.readOperations = 100
		const r = managed({ db })
		expect(r.scope.tenant).toBe('one')
		expect(r.scope.policyVersion).toBe('original')
		expect(r.budgets.readOperations).toBe(1)
		expect(await r.db.get('tasks', id<'tasks'>('tasks:1'))).not.toBeNull()
		expect(() => r.db.query('unruled')).toThrow(/UNSUPPORTED_MANAGED_READ/)
	})
})
