// @vitest-environment node
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { Effect } from 'effect'
import { z } from 'zod'
import { zodTable, zodVariantTable } from '../src/zod-table'
import { createEffectFoundation } from '../src/effect'
import { defineDomainContract } from '../src/contracts'
import { checkArchitecture } from '../src/oxlint'

afterEach(() => vi.restoreAllMocks())

it.each(['ordinary', 'variant'] as const)(
	'%s declaration defers derived schemas and memoizes first reads',
	(kind) => {
		const partial = vi.spyOn(z.ZodObject.prototype, 'partial')
		const boundary =
			kind === 'ordinary'
				? zodTable('items', () => ({ name: z.string() }), {
						publicFields: ['name'],
						commandFields: ['name'],
					})
				: zodVariantTable(
						'items',
						z.discriminatedUnion('type', [
							z.strictObject({ type: z.literal('item'), name: z.string() }),
						]),
						{
							discriminator: 'type',
							variants: { item: { publicFields: ['name'], commandFields: ['name'] } },
						},
					)
		expect(partial).not.toHaveBeenCalled()
		expect(boundary.table).toBeDefined()
		const update = boundary.updateSchema
		expect(partial).toHaveBeenCalledTimes(1)
		expect(boundary.updateSchema).toBe(update)
		expect(boundary.publicDto).toBe(boundary.dto())
		expect(boundary.tools).toBe(boundary.tools)
		expect(
			boundary.insertSchema.safeParse(
				kind === 'ordinary' ? { name: 'ok' } : { type: 'item', name: 'ok' },
			).success,
		).toBe(true)
	},
)

it('builds thunk contracts on property read and preserves enumeration and schema identities', () => {
	let builds = 0
	const input = z.string()
	const contract = defineDomainContract(() => {
		builds++
		return { queries: { get: { input, result: z.string() } } }
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
					input: z.number(),
					result: z.number(),
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
					input: z.number(),
					result: z.number(),
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

it('memoizes page composition while returning independent public validators', async () => {
	const { defineRelations } = await import('../src/relations')
	const items = zodTable('items', () => ({ name: z.string() }), { publicFields: ['name'] })
	const registry = defineRelations({ items }, () => ({}))
	// The first call returns its fresh build; a repeated selection captures the
	// recipe, and only later calls reconstruct without recomposing.
	const first = registry.tables.items.pageDto({})
	const captured = registry.tables.items.pageDto({})
	const extend = vi.spyOn(z.ZodObject.prototype, 'extend')
	const second = registry.tables.items.pageDto({})
	expect(extend).not.toHaveBeenCalled()
	expect(second).not.toBe(first)
	expect(second).not.toBe(captured)
	const page = { page: [{ _id: 'items:1', name: 'ok' }], isDone: true, continueCursor: '' }
	expect(second.parse(page)).toEqual(page)
})

it('reuses ordinary pagination native field conversion and preserves fresh validators', () => {
	const items = zodTable('items', () => ({ name: z.string() }), { publicFields: ['name'] })
	const first = items.paginationOpts({ name: true })
	const fields = items.schema._zod.def.shape
	const nativeReads = vi.fn(() => fields)
	Object.defineProperty(items.schema._zod.def, 'shape', { configurable: true, get: nativeReads })
	const second = items.paginationOpts({ name: true })
	expect(nativeReads).not.toHaveBeenCalled()
	expect(second).not.toBe(first)
	expect(second.safeParse({ numItems: 1, cursor: null, filters: { name: 'ok' } }).success).toBe(
		true,
	)
	expect(
		second.safeParse({ numItems: 1, cursor: null, filters: { secret: 'hidden' } }).success,
	).toBe(false)
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
		return { queries: { get: { input: z.number(), result: z.number() } } }
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

it('memoizes relation pagination predicates without sharing mutable public validators', async () => {
	const { defineRelations } = await import('../src/relations')
	const items = zodTable('items', () => ({ rank: z.number() }), { publicFields: ['rank'] })
	const registry = defineRelations({ items }, () => ({}))
	const extend = vi.spyOn(z.ZodObject.prototype, 'extend')
	const first = registry.tables.items.paginationOpts({ rank: true })
	const firstBuilds = extend.mock.calls.length
	extend.mockClear()
	const second = registry.tables.items.paginationOpts({ rank: true })
	expect(extend.mock.calls.length).toBeLessThan(firstBuilds)
	const filter = first.shape.filters.unwrap()
	if (!(filter instanceof z.ZodObject)) throw new Error('Expected filter object')
	const predicate = filter.shape.rank.unwrap()
	if (!(predicate instanceof z.ZodUnion)) throw new Error('Expected scalar predicate')
	Reflect.set(predicate.options, '0', z.string())
	const invalid = { numItems: 1, cursor: null, filters: { rank: 'invalid' } }
	expect(first.safeParse(invalid).success).toBe(true)
	expect(second.safeParse(invalid).success).toBe(false)
	expect(registry.tables.items.paginationOpts({ rank: true }).safeParse(invalid).success).toBe(
		false,
	)
})

it('preserves writable public declaration properties without replacing the internal DTO owner', () => {
	const items = zodTable('items', () => ({ name: z.string() }), { publicFields: ['name'] })
	const replacement = z.strictObject({ name: z.string().min(5) })
	items.publicDto = replacement
	expect(items.publicDto).toBe(replacement)
	expect(items.dto().safeParse({ name: 'ok' }).success).toBe(true)
	expect(items.publicDto.safeParse({ name: 'ok' }).success).toBe(false)
})
