import { expect, test } from 'vite-plus/test'
import { v } from 'convex/values'
import { defineFilterContract } from '../src/filters'

test('one pure declaration supplies bounded scalar filters', () => {
	const contract = defineFilterContract({
		status: v.union(v.literal('open'), v.literal('done')),
		count: v.optional(v.int64()),
	})
	expect(contract.schema.parse({ status: { in: ['open'] }, count: { exists: false } })).toEqual({
		status: { in: ['open'] },
		count: { exists: false },
	})
	expect(contract.schema.safeParse({ status: 'other' }).success).toBe(false)
})

import { z } from 'zod'
import { zodTable, zodToConvex } from '../src/zod-table'
import { defineRelations } from '../src/relations-public'
import { defineSchema, queryGeneric, makeFunctionReference } from 'convex/server'
import { convexTest } from 'convex-test'
import { NoOp } from 'convex-helpers/server/customFunctions'
import { zCustomQuery } from '../src/zod-registration'
import { captureDto, materializeDto } from '../src/querying/schema-snapshot'

const contract = defineFilterContract({
	status: v.union(v.literal('open'), v.literal('done')),
	title: v.string(),
	score: v.number(),
	count: v.optional(v.int64()),
	active: v.boolean(),
	nullable: v.union(v.string(), v.null()),
	reference: v.id('targets'),
})
const records = zodTable('records', () => contract.fields)
const targets = zodTable('targets', () => ({ value: z.boolean() }))
const registry = defineRelations({ records }, () => ({}))
const options = registry.tables.records.filters(contract)

test('binding uses exact shared schema and verifies native optional/type/table correspondence', () => {
	expect(options.shape.filters.unwrap()).toBe(contract.schema)
	expect(() =>
		registry.tables.records.filters(defineFilterContract({ title: v.number() })),
	).toThrow('mismatch')
	expect(() =>
		registry.tables.records.filters(defineFilterContract({ reference: v.id('other') })),
	).toThrow('mismatch')
	expect(() => registry.tables.records.filters(defineFilterContract({ count: v.int64() }))).toThrow(
		'mismatch',
	)
	expect(() => defineFilterContract({ unsupported: v.array(v.string()) })).toThrow('Unsupported')
	expect(() => defineFilterContract({ variant: v.object({ tag: v.string() }) })).toThrow(
		'Unsupported',
	)
	const restored = materializeDto(captureDto(options))
	const native = JSON.stringify(zodToConvex(restored))
	expect(native).toContain('targets')
	expect(
		restored.parse({ numItems: 1, cursor: null, filters: { count: { in: [1n] } } }),
	).toBeDefined()
})

test('descriptors preserve scalar metadata and do not invent date semantics', () => {
	const entries = Object.fromEntries(contract.describe().map((d) => [d.field, d]))
	expect(entries.status).toMatchObject({
		kind: 'enum',
		values: ['open', 'done'],
		operators: ['eq', 'in', 'gt', 'gte', 'lt', 'lte'],
	})
	expect(entries.count).toMatchObject({ kind: 'bigint', optional: true, nullable: false })
	expect(entries.nullable).toMatchObject({ kind: 'union', nullable: true, operators: ['eq', 'in'] })
	expect(entries.reference).toMatchObject({
		kind: 'id',
		idTables: ['targets'],
		operators: ['eq', 'in'],
	})
	expect(entries.active.kind).toBe('boolean')
	expect(entries.score.kind).toBe('number')
})

test('registered endpoint and browser contract accept the same bounded grammar and raw invalid inputs reject', async () => {
	const endpoint = zCustomQuery(
		queryGeneric,
		NoOp,
	)({ args: options, returns: z.any(), handler: (_ctx, args) => args.filters ?? {} })
	const t = convexTest(defineSchema({ records: records.table, targets: targets.table }), {
		'./functions.ts': async () => ({ endpoint }),
		'./_generated/server.ts': async () => ({ query: queryGeneric }),
	})
	const reference = makeFunctionReference<'query'>('functions:endpoint')
	const id = await t.run((ctx) => ctx.db.insert('targets', { value: true }))
	const valid = [
		{},
		{ status: { in: ['open', 'done'] } },
		{ count: { exists: false } },
		{ count: { gte: 1n, lt: 3n } },
		{ score: { gte: 1, lt: 5 } },
		{ nullable: null },
		{ reference: id },
		{ not: { or: [{ active: false }, { title: { gt: 'z' } }] } },
	]
	for (const filters of valid) {
		expect(contract.schema.safeParse(filters).success).toBe(true)
		expect(await t.query(reference, { numItems: 1, cursor: null, filters })).toEqual(filters)
	}
	const invalid = [
		{ status: 'missing' },
		{ count: 1 },
		{ score: '1' },
		{ score: Infinity },
		{ score: NaN },
		{ count: 1n << 63n },
		{ active: { gt: true } },
		{ title: null },
		{ nullable: { exists: false } },
		{ reference: 123 },
		{ reference: { in: [null] } },
		{ unknown: true },
		{ title: {} },
		{ variant: { tag: 'a', filters: {} } },
		{ relation: { some: {} } },
	]
	for (const filters of invalid) {
		expect(contract.schema.safeParse(filters).success).toBe(false)
		await expect(t.query(reference, { numItems: 1, cursor: null, filters })).rejects.toBeDefined()
	}
	// Inspect the native table-ID validator on the actual registered function too.
	// SAFETY: Convex attaches exportArgs to registered functions at runtime.
	const raw = endpoint as typeof endpoint & { exportArgs(): string }
	expect(raw.exportArgs()).toContain('"tableName":"targets"')
})

test('three-valued evaluation distinguishes known missing from inaccessible including boolean composition', () => {
	const c = defineFilterContract({ optional: v.optional(v.string()), active: v.boolean() })
	const visible = new Set(['optional', 'active']),
		hidden = new Set(['active'])
	expect(c.evaluate({ optional: { exists: false } }, {}, visible)).toBe(true)
	expect(c.evaluate({ optional: { exists: false } }, {}, hidden)).toBe('unknown')
	expect(c.evaluate({ not: { optional: { exists: false } } }, {}, hidden)).toBe('unknown')
	expect(
		c.evaluate({ and: [{ optional: 'x' }, { active: true }] }, { active: false }, hidden),
	).toBe(false)
	expect(c.evaluate({ or: [{ optional: 'x' }, { active: true }] }, { active: true }, hidden)).toBe(
		true,
	)
	expect(c.evaluate({ optional: { exists: false } }, {})).toBe(true)
	expect(c.evaluate({ optional: { eq: 'x' } }, {})).toBe(false)
})

test('versioned URL codec canonicalizes keys, retains arrays and bigint, and rejects bounded invalid input', () => {
	const a = { status: { in: ['open', 'done'] }, count: { gte: 1n } } as const
	const first = contract.searchParam.encode({ status: { in: [...a.status.in] }, count: a.count })
	const second = contract.searchParam.encode({
		count: { gte: 1n },
		status: { in: ['open', 'done'] },
	})
	expect(first).toEqual(second)
	if (!first.success) throw new Error(first.error)
	expect(contract.searchParam.decode(first.value)).toEqual({
		success: true,
		value: { status: { in: ['open', 'done'] }, count: { gte: 1n } },
	})
	expect(
		contract.searchParam.encode({ status: { in: ['done', 'open'] }, count: { gte: 1n } }),
	).not.toEqual(first)
	for (const input of [
		'',
		'{}',
		'{"v":2,"filters":{}}',
		'{"v":1,"filters":{"count":{"$integer":"bad"}}}',
		'x'.repeat(32769),
	])
		expect(contract.searchParam.decode(input).success).toBe(false)
	const cycle: any = {}
	cycle.not = cycle
	const getter = Object.defineProperty({}, 'title', {
		enumerable: true,
		get() {
			throw new Error('getter must not run')
		},
	})
	for (const filters of [
		cycle,
		getter,
		{ title: 'x'.repeat(40000) },
		{ status: { in: Array(101).fill('open') } },
		{ not: { not: { not: { not: { not: { active: true } } } } } },
	])
		expect(contract.searchParam.encode(filters).success).toBe(false)
	const deep = '{"v":1,"filters":' + '['.repeat(10000) + '0' + ']'.repeat(10000) + '}'
	expect(contract.searchParam.decode(deep).success).toBe(false)
})

test('native declaration mutation cannot change an already created contract', () => {
	const input = { status: v.union(v.literal('open'), v.literal('done')) }
	const c = defineFilterContract(input)
	Object.defineProperty(input.status.members[0], 'value', { value: 'changed' })
	expect(c.schema.parse({ status: 'open' })).toEqual({ status: 'open' })
	expect(c.schema.safeParse({ status: 'changed' }).success).toBe(false)
	expect(c.describe()[0].values).toEqual(['open', 'done'])
	expect(c.native.status.json).toEqual({
		type: 'union',
		value: [
			{ type: 'literal', value: 'open' },
			{ type: 'literal', value: 'done' },
		],
	})
})

test('cloned shared schemas and captured bindings retain bounded constructor preflight', () => {
	const cyclic: any = {}
	cyclic.not = cyclic
	expect(contract.schema.clone().safeParse(cyclic).success).toBe(false)
	expect(
		materializeDto(captureDto(options)).safeParse({ numItems: 1, cursor: null, filters: cyclic })
			.success,
	).toBe(false)
	const getter = Object.defineProperty({}, 'title', {
		enumerable: true,
		get() {
			throw new Error('must not execute')
		},
	})
	expect(contract.schema.clone().safeParse(getter).success).toBe(false)
})

test('derived shared ID schemas retain native endpoint and snapshot validators', async () => {
	const idContract = defineFilterContract({ reference: v.id('targets') })
	const base = idContract.fields.reference
	const derived = [
		base.clone(),
		base.describe('Reference'),
		base.meta({ title: 'Reference' }),
		base.refine(() => true),
	]
	for (const field of derived) {
		for (const args of [
			z.object({ reference: field }),
			materializeDto(captureDto(z.object({ reference: field }))),
		]) {
			const endpoint = zCustomQuery(
				queryGeneric,
				NoOp,
			)({ args, returns: z.any(), handler: (_ctx, value) => value.reference })
			// SAFETY: registered Convex functions expose their actual native argument validator.
			const raw = endpoint as typeof endpoint & { exportArgs(): string }
			expect(raw.exportArgs()).toContain('"tableName":"targets"')
			const t = convexTest(defineSchema({ targets: targets.table, others: targets.table }), {
				'./functions.ts': async () => ({ endpoint }),
				'./_generated/server.ts': async () => ({ query: queryGeneric }),
			})
			const valid = await t.run((ctx) => ctx.db.insert('targets', { value: true }))
			const wrong = await t.run((ctx) => ctx.db.insert('others', { value: true }))
			const reference = makeFunctionReference<'query'>('functions:endpoint')
			expect(await t.query(reference, { reference: valid })).toBe(valid)
			await expect(t.query(reference, { reference: wrong })).rejects.toBeDefined()
			await expect(t.query(reference, { reference: 'not-an-id' })).rejects.toBeDefined()
		}
	}
})
