// @vitest-environment node
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { Effect } from 'effect'
import { k } from '../src/k'
import { KObject } from '../src/k/object'
import { kTable } from '../src/table'
import { createEffectFoundation } from '../src/effect'
import { defineDomainContract } from '../src/contracts'
import { checkArchitecture } from '../src/oxlint'

afterEach(() => vi.restoreAllMocks())

it('builds thunk contracts on property read and preserves enumeration and schema identities', () => {
	let builds = 0
	const input = k.string()
	const contract = defineDomainContract(() => {
		builds++
		return { queries: { get: { input, result: k.string() } } }
	})
	expect(builds).toBe(0)
	expect(contract.queries.get.input).toBe(input)
	expect(Object.keys(contract)).toEqual(['queries'])
	expect({ ...contract }.queries).toBe(contract.queries)
	expect(builds).toBe(1)
})

it('defers both foundation registries until execution, builds once, and keeps context invocation-local', async () => {
	let queryBuilds = 0
	let commandBuilds = 0
	const foundation = createEffectFoundation({
		writeAudit: () => {},
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
		},
	})
	const query = foundation.Query({
		context: (host: number) => host,
		operations: ({ query }) => {
			queryBuilds++
			return {
				get: query({
					input: k.number(),
					result: k.number(),
					handler: (input, context) => input + context,
				}),
			}
		},
	})
	const command = foundation.Command({
		context: (host: number) => host,
		operations: ({ command }) => {
			commandBuilds++
			return {
				save: command({
					input: k.number(),
					result: k.number(),
					classification: 'business',
					handler: (input, context) => input + context,
					audit: () => ({
						operation: 'save',
						actorId: 'actor',
						aggregate: { type: 'item', id: '1' },
					}),
				}),
			}
		},
	})
	const bound = query.withContext(2)
	expect([queryBuilds, commandBuilds]).toEqual([0, 0])
	expect(await Effect.runPromise(bound.exec('get', 1))).toBe(3)
	expect(await Effect.runPromise(query.exec('get', 1, 5))).toBe(6)
	expect(await Effect.runPromise(command.withContext(3).exec('save', 1))).toBe(4)
	expect(await Effect.runPromise(command.exec('save', 2, 7))).toBe(9)
	expect([queryBuilds, commandBuilds]).toEqual([1, 1])
})

it('force-builds selected registries through checkArchitecture without executing handlers', () => {
	let builds = 0
	const foundation = createEffectFoundation({
		writeAudit: () => {},
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
		},
	})
	const registry = foundation.Query({
		context: () => ({}),
		operations: () => {
			builds++
			throw new Error('invalid registry fixture')
		},
	})
	expect(builds).toBe(0)
	expect(() => checkArchitecture({ registries: [registry] })).toThrow('invalid registry fixture')
	expect(() => checkArchitecture({ registries: [registry] })).toThrow('invalid registry fixture')
	expect(builds).toBe(1)
})

it('memoizes page composition and shares the immutable k validator', async () => {
	const { defineRelations } = await import('../src/relations')
	const items = kTable('items', { name: k.string() }, { publicFields: ['name'] })
	const registry = defineRelations({ items }, () => ({}))
	// v1 rebuilt independent Zod copies so callers could not mutate each other's; k records are
	// immutable, so a repeated selection returns the boundary it built the first time.
	const first = registry.tables.items.pageDto({})
	const extend = vi.spyOn(KObject.prototype, 'extend')
	const second = registry.tables.items.pageDto({})
	expect(extend).not.toHaveBeenCalled()
	expect(second).toBe(first)
	const page = { page: [{ _id: 'items:1', name: 'ok' }], isDone: true, continueCursor: '' }
	expect(second.parse(page)).toEqual(page)
	extend.mockRestore()
})

it.each(['Query', 'Command'] as const)(
	'%s defers configuration defects through exec and caches failures',
	async (kind) => {
		let builds = 0
		let resolutions = 0
		const failure = new Error('configuration fixture')
		const foundation = createEffectFoundation({
			writeAudit: () => {},
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
			},
		})
		const configuration = {
			context: (_host: Record<never, never>) => {
				resolutions++
				return {}
			},
			operations: () => {
				builds++
				throw failure
			},
		}
		const registry =
			kind === 'Query' ? foundation.Query(configuration) : foundation.Command(configuration)
		const bound = registry.withContext({})
		expect(builds).toBe(0)
		// The throwing factory has no operation keys, so a JavaScript caller probes the runtime boundary.
		// @ts-expect-error invalid configuration intentionally has no inferred operation key
		await expect(Effect.runPromise(bound.exec('missing', {}))).rejects.toBe(failure)
		// @ts-expect-error invalid configuration intentionally has no inferred operation key
		await expect(Effect.runPromise(registry.exec('missing', {}, {}))).rejects.toBe(failure)
		expect(builds).toBe(1)
		expect(resolutions).toBe(0)
	},
)

it('force-checks contracted thunk registries once without resolving context or calling handlers', async () => {
	let builds = 0
	let resolutions = 0
	let calls = 0
	const contract = defineDomainContract(() => {
		builds++
		return { queries: { get: { input: k.number(), result: k.number() } } }
	})
	const foundation = createEffectFoundation({
		writeAudit: () => {},
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
		},
	})
	const registry = foundation.Query({
		contract,
		context: () => {
			resolutions++
			return {}
		},
		operations: ({ query }) => ({
			get: query.get({
				handler: (input) => {
					calls++
					return input
				},
			}),
		}),
	})
	expect(builds).toBe(0)
	checkArchitecture({ convexDir: '__lazy_configuration_only__', registries: [registry] })
	checkArchitecture({ convexDir: '__lazy_configuration_only__', registries: [registry] })
	expect([builds, resolutions, calls]).toEqual([1, 0, 0])
	expect(await Effect.runPromise(registry.exec('get', 3, {}))).toBe(3)
	expect([builds, resolutions, calls]).toEqual([1, 1, 1])
})

it('memoizes relation pagination predicates and shares the immutable k validator', async () => {
	const { defineRelations } = await import('../src/relations')
	const items = kTable('items', { rank: k.number() }, { publicFields: ['rank'] })
	const registry = defineRelations({ items }, () => ({}))
	const extend = vi.spyOn(KObject.prototype, 'extend')
	const first = registry.tables.items.paginationOpts({ rank: true })
	const firstBuilds = extend.mock.calls.length
	extend.mockClear()
	const second = registry.tables.items.paginationOpts({ rank: true })
	expect(extend.mock.calls.length).toBeLessThan(firstBuilds)
	// v1 also mutated one result's Zod predicate to prove isolation; k records are immutable.
	expect(second).toBe(first)
	const invalid = { numItems: 1, cursor: null, filters: { rank: 'invalid' } }
	expect(first.safeParse(invalid).success).toBe(false)
	expect(second.safeParse({ ...invalid, filters: { rank: 1 } }).success).toBe(true)
	extend.mockRestore()
})
