/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Negative fixtures deliberately build cyclic, accessor-bearing and unsupported raw values. */
// The filter grammar, compact projection and shared contract on `k` (U23). These are the `k` twins
// of filters-lazy-boundary.unit.test.ts, compact-pagination.test.ts and filter-contracts.unit.test.ts,
// which keep testing the v1 bridge until the cutover; assertions that read Zod internals (clone, meta,
// mutable check definitions, z.lazy capture fallbacks) have no `k` counterpart, since `k` records are
// immutable and have no such API.
import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { v } from 'convex/values'
import { describe, expect, test, vi } from 'vite-plus/test'
import { k, KValidationError, type KType } from '../src/k'
import { defineFilterContract } from '../src/filters'
import { compactNativeFilter } from '../src/querying/filter-boundary'
import {
	compactFilterMetadata,
	lazyRelationFilterSchema,
	normalizeFilters,
	paginationGrammar,
	relationFilterSchema,
	scalarPredicateFromSchema,
	type FilterGrammar,
} from '../src/querying/shared/filters'
import { kTable } from '../src/table'
import { z } from 'zod'
import {
	relationFilterSchema as v1RelationFilterSchema,
	scalarPredicateFromSchema as v1ScalarPredicate,
	type FilterGrammar as V1FilterGrammar,
} from '../src/querying/v1-zod-shared-filters'

function predicate(schema: KType, range = false, optional = false) {
	return optionalOf(scalarPredicateFromSchema(schema, range, optional))
}

function optionalOf(schema: KType): KType {
	// SAFETY: every KType at runtime is a k schema record with the chain methods.
	return (schema as ReturnType<typeof k.any>).optional()
}

function nativeJson(validator: GenericValidator): ValidatorJSON {
	// SAFETY: Convex validators expose their registration JSON at runtime; declarations mark it internal.
	return (validator as GenericValidator & { readonly json: ValidatorJSON }).json
}

function issuesOf(run: () => void) {
	try {
		run()
	} catch (error) {
		if (error instanceof KValidationError) return error.data
		throw error
	}
	throw new Error('expected a KValidationError')
}

/**
 * people -team(one)-> teams -members(many)-> people, plus a variant table whose branches carry their
 * own relation. Relation getters count their reads.
 */
function grammars() {
	const reads: string[] = []
	const people: FilterGrammar = {
		fields: {
			name: predicate(k.string()),
			age: predicate(k.number(), true),
			nick: predicate(k.string(), false, true),
		},
		relations: {},
	}
	const teams: FilterGrammar = { fields: { title: predicate(k.string()) }, relations: {} }
	const card: FilterGrammar = { fields: { last4: predicate(k.string()) }, relations: {} }
	const cash: FilterGrammar = { fields: { till: predicate(k.number(), true) }, relations: {} }
	const payments: FilterGrammar = {
		fields: { kind: predicate(k.enum(['card', 'cash'])), amount: predicate(k.number(), true) },
		variants: { discriminator: 'kind', options: { card, cash } },
		relations: {},
	}
	function relate(
		source: FilterGrammar,
		name: string,
		cardinality: 'one' | 'many',
		target: () => FilterGrammar,
	) {
		Object.defineProperty(source.relations, name, {
			enumerable: true,
			get: () => {
				reads.push(name)
				return { cardinality, target: target() }
			},
		})
	}
	relate(people, 'team', 'one', () => teams)
	relate(teams, 'members', 'many', () => people)
	relate(people, 'payments', 'many', () => payments)
	relate(card, 'owner', 'one', () => people)
	return { people, reads }
}

const corpus: unknown[] = [
	undefined,
	{},
	{ name: 'a' },
	{ name: { eq: 'a' }, age: { gt: 1, lte: 9 } },
	{ nick: { exists: false } },
	{ fields: { name: 'a', age: { gte: 3 } } },
	{ team: null },
	{ team: { title: 'x' } },
	{ team: { members: { some: { name: 'a' } } } },
	{ team: { members: { none: { team: { title: 'y' } } } } },
	{ team: { members: { some: { team: { members: { some: { name: 'deep' } } } } } } },
	{ and: [{ name: 'a' }, { team: { title: 'x' } }] },
	{ or: [{ payments: { some: { amount: { gt: 1 } } } }, { not: { team: null } }] },
	{ not: { and: [{ not: { team: { members: { some: {} } } } }] } },
	{ payments: { some: { variant: { tag: 'card', filters: { last4: '1234' } } } } },
	{ payments: { some: { variant: { tag: 'card', filters: { owner: { name: 'a' } } } } } },
	{ payments: { none: { variant: { tag: 'cash', filters: { till: { lt: 3 } } } } } },
	// Invalid inputs.
	{ unknown: 1 },
	{ name: { eq: 1 } },
	{ name: {} },
	{ team: { some: { title: 'x' } } },
	{ team: { members: { title: 'x' } } },
	{ team: { members: { some: {}, none: {} } } },
	{ team: { members: { any: {} } } },
	{ payments: { some: { variant: { tag: 'cheque', filters: {} } } } },
	{ payments: { some: { variant: { tag: 'cash', filters: { last4: '1' } } } } },
	{ team: { members: { some: { team: { members: { some: { team: { title: 'x' } } } } } } } },
	{ and: [] },
	{ and: Array.from({ length: 300 }, () => ({ name: 'a' })) },
	{ constructor: { some: {} } },
	{ toString: null },
	JSON.parse('{"__proto__": {"name": "a"}}'),
	Object.create({ name: 'inherited' }),
	[],
	'name',
	null,
]

describe('lazy engine filter boundary on k', () => {
	test('accepts, rejects and outputs exactly what the eager boundary does', () => {
		for (const input of corpus) {
			const eager = optionalOf(relationFilterSchema(grammars().people))
			const lazy = optionalOf(lazyRelationFilterSchema(grammars().people))
			const expected = schemaParse(eager, input)
			const actual = schemaParse(lazy, input)
			expect(actual.success, JSON.stringify(input)).toBe(expected.success)
			if (expected.success && actual.success)
				expect(actual.data, JSON.stringify(input)).toEqual(expected.data)
		}
	})

	test('accepts and rejects exactly what the v1 Zod grammar did on the whole corpus', () => {
		const zodPredicate = (schema: z.ZodType, range = false, optional = false) =>
			v1ScalarPredicate(schema, range, optional).optional()
		const teams: V1FilterGrammar = { fields: { title: zodPredicate(z.string()) }, relations: {} }
		const people: V1FilterGrammar = {
			fields: {
				name: zodPredicate(z.string()),
				age: zodPredicate(z.number(), true),
				nick: zodPredicate(z.string(), false, true),
			},
			relations: {},
		}
		const card: V1FilterGrammar = { fields: { last4: zodPredicate(z.string()) }, relations: {} }
		const cash: V1FilterGrammar = {
			fields: { till: zodPredicate(z.number(), true) },
			relations: {},
		}
		const payments: V1FilterGrammar = {
			fields: {
				kind: zodPredicate(z.enum(['card', 'cash'])),
				amount: zodPredicate(z.number(), true),
			},
			variants: { discriminator: 'kind', options: { card, cash } },
			relations: {},
		}
		people.relations.team = { cardinality: 'one', target: teams }
		teams.relations.members = { cardinality: 'many', target: people }
		people.relations.payments = { cardinality: 'many', target: payments }
		card.relations.owner = { cardinality: 'one', target: people }
		const v1 = v1RelationFilterSchema(people).optional()
		const v2 = optionalOf(relationFilterSchema(grammars().people))
		for (const input of corpus)
			expect(schemaParse(v2, input).success, JSON.stringify(input)).toBe(
				v1.safeParse(input).success,
			)
	})

	test('one lazy schema stays exact across many inputs and reuses its shapes', () => {
		const schema = optionalOf(lazyRelationFilterSchema(grammars().people))
		for (const round of [0, 1])
			for (const input of corpus) {
				const eager = schemaParse(optionalOf(relationFilterSchema(grammars().people)), input)
				expect(schemaParse(schema, input).success, `${round} ${JSON.stringify(input)}`).toBe(
					eager.success,
				)
			}
	})

	test('reads only the relations an input names', () => {
		const { people, reads } = grammars()
		const schema = lazyRelationFilterSchema(people)
		expect(reads).toEqual([])
		schema.parse({ name: 'a', and: [{ age: { gt: 1 } }] })
		expect(reads).toEqual([])
		schema.parse({ team: { title: 'x' } })
		expect(new Set(reads)).toEqual(new Set(['team']))
		reads.length = 0
		schema.parse({ payments: { some: { variant: { tag: 'card', filters: { last4: '1' } } } } })
		expect(new Set(reads)).toEqual(new Set(['payments']))
		// The eager boundary reads every relation on its first use; v2 defers even that until then.
		const eager = grammars()
		const declared = relationFilterSchema(eager.people)
		expect(eager.reads).toEqual([])
		declared.safeParse({})
		expect(new Set(eager.reads)).toEqual(new Set(['team', 'members', 'payments', 'owner']))
	})

	test('shared-target fan-out costs work linear in the input, cold and warm', () => {
		function fanOut() {
			let reads = 0
			const people: FilterGrammar = { fields: { name: predicate(k.string()) }, relations: {} }
			for (let i = 0; i < 32; i++)
				Object.defineProperty(people.relations, `r${i}`, {
					enumerable: true,
					get: () => {
						reads++
						return { cardinality: 'one', target: people }
					},
				})
			return { people, reads: () => reads }
		}
		interface FanOutFilter {
			[relation: string]: FanOutFilter | string
		}
		const level = (child: FanOutFilter): FanOutFilter =>
			Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`r${i}`, i ? {} : child]))
		const input = level(level(level(level({ name: 'deep' }))))
		const lazy = fanOut()
		const schema = lazyRelationFilterSchema(lazy.people)
		const result = schema.safeParse(input)
		const cold = lazy.reads()
		expect(cold).toBeLessThan(2000)
		schema.safeParse(input)
		expect(lazy.reads() - cold).toBeLessThan(1000)
		const eager = relationFilterSchema(fanOut().people).safeParse(input)
		expect(result.success).toBe(eager.success)
		if (eager.success && result.success) expect(result.data).toEqual(eager.data)
	})

	test('reports an unknown field and a budget excess with code VALIDATION and their paths', () => {
		const schema = relationFilterSchema(grammars().people)
		expect(issuesOf(() => schema.parse({ not: { team: { nope: 1 } } }))).toEqual({
			code: 'VALIDATION',
			issues: [
				{ path: ['not', 'team', 'nope'], code: 'unrecognized_key', message: expect.any(String) },
			],
		})
		const options = k.object({ filters: schema.optional() })
		expect(
			issuesOf(() => options.parse({ filters: { and: [{ name: { eq: 1 } }] } })).issues,
		).toEqual([
			expect.objectContaining({ path: ['filters', 'and', 0, 'name'], code: 'invalid_union' }),
		])
		const nested = (n: number): object => (n ? { not: nested(n - 1) } : {})
		expect(issuesOf(() => options.parse({ filters: nested(5) })).issues).toEqual([
			{
				path: ['filters'],
				code: 'custom',
				message: 'Unsupported filter layout or depth/node budget exceeded',
			},
		])
	})

	test('rejects accessors before reading them', () => {
		let reads = 0
		const getter = Object.defineProperty({}, 'name', {
			enumerable: true,
			get() {
				reads++
				return 'a'
			},
		})
		const cyclic: any = {}
		cyclic.not = cyclic
		for (const schema of [
			relationFilterSchema(grammars().people),
			lazyRelationFilterSchema(grammars().people),
		]) {
			expect(schema.safeParse(getter).success).toBe(false)
			expect(schema.safeParse(cyclic).success).toBe(false)
		}
		expect(reads).toBe(0)
	})
})

const stages = [
	's0',
	's1',
	's2',
	's3',
	's4',
	's5',
	's6',
	's7',
	's8',
	's9',
	's10',
	's11',
	's12',
] as const
const clients = kTable('clients', {
	status: k.string(),
	lifecycleStage: k.enum(stages),
	email: k.string(),
})
const target: FilterGrammar = { fields: { email: predicate(k.string()) }, relations: {} }
const relationGrammar: FilterGrammar = {
	fields: { status: predicate(k.enum(stages)) },
	relations: { contact: { cardinality: 'one', target }, contacts: { cardinality: 'many', target } },
	variants: { discriminator: 'kind', options: { a: target, b: target } },
}
const idGrammar: FilterGrammar = {
	fields: {
		owner: predicate(k.id('users')),
		mixed: predicate(k.union([k.id('users'), k.string()])),
	},
	relations: {
		contact: {
			cardinality: 'one',
			target: { fields: { owner: predicate(k.id('contacts')) }, relations: {} },
		},
	},
	variants: {
		discriminator: 'kind',
		options: {
			a: { fields: { owner: predicate(k.id('users')) }, relations: {} },
			b: { fields: { owner: predicate(k.id('contacts')) }, relations: {} },
		},
	},
}
const full = clients.paginationOpts({ status: true, lifecycleStage: true, email: true })
const compact = clients.paginationOpts(
	{ status: true, lifecycleStage: true, email: true },
	{ validator: 'compact' },
)

function compactRoot(grammar: FilterGrammar) {
	return relationFilterSchema(grammar, undefined, { validator: 'compact' })
}

describe('compact pagination grammar association on k', () => {
	test('recovers the grammar through describe and refine records', () => {
		const schema = compactRoot(relationGrammar)
		const expected = compactFilterMetadata(schema)
		expect(expected).toBeDefined()
		for (const root of [schema, schema.describe('filter'), schema.refine(() => true)]) {
			expect(compactFilterMetadata(root)).toBe(expected)
			const args = k.object({ filters: root.optional() }).extend({ other: k.string().optional() })
			const grammar = paginationGrammar(args)
			expect(Object.keys(grammar!.fields)).toEqual(['status'])
			expect(normalizeFilters({ contact: { email: 'a' } }, grammar)).toMatchObject({
				children: [{ kind: 'relation', name: 'contact' }],
			})
			expect(root.safeParse({ not: { not: { not: { not: { status: 's1' } } } } }).success).toBe(
				true,
			)
			expect(
				root.safeParse({ not: { not: { not: { not: { not: { status: 's1' } } } } } }).success,
			).toBe(false)
		}
		expect(compactFilterMetadata(schema.optional())).toBeUndefined()
	})

	test('consumer edits do not mutate the captured generated grammar', () => {
		const grammar: FilterGrammar = { fields: { value: predicate(k.string()) }, relations: {} }
		const schema = compactRoot(grammar)
		const metadata = compactFilterMetadata(schema)!
		grammar.fields.value = predicate(k.number())
		expect(metadata.semantic.safeParse({ value: 'valid' }).success).toBe(true)
		expect(metadata.semantic.safeParse({ value: 3 }).success).toBe(false)
		expect(Object.isFrozen(metadata.grammar.fields)).toBe(true)
	})

	test('default and compact inputs/outputs match and ordinary conversion stays full', () => {
		for (const filters of [
			{},
			{ lifecycleStage: { gte: 's1', in: ['s2'] } },
			{ fields: { email: 'a' } },
			{ not: { not: { not: { not: { status: 'a' } } } } },
		]) {
			const input = { numItems: 1, cursor: null, filters }
			expect(compact.parse(input)).toEqual(full.parse(input))
		}
		expect(nativeJson(compact.validator)).toEqual(nativeJson(full.validator))
	})
})

describe('compact native projection on k', () => {
	test('retains exact common predicates and IDs while compacting only deep nodes', () => {
		const root = compact.shape.filters.unwrap()
		const json = JSON.parse(JSON.stringify(nativeJson(compactNativeFilter(root)!)))
		const baseline = JSON.parse(JSON.stringify(nativeJson(full.shape.filters.unwrap().validator)))
		expect(json.value.status).toEqual(baseline.value.status)
		expect(json.value.fields).toEqual(baseline.value.fields)
		expect(json.value.not.fieldType.value.lifecycleStage).toEqual(
			baseline.value.not.fieldType.value.lifecycleStage,
		)
		expect(json.value.not.fieldType.value.not.fieldType).toEqual({ type: 'any' })
		const idSchema = compactRoot(idGrammar)
		const ids = JSON.stringify(nativeJson(compactNativeFilter(idSchema)!))
		expect(ids).toContain('users')
		expect(ids).toContain('contacts')
		expect(ids.length).toBeLessThanOrEqual(JSON.stringify(nativeJson(idSchema.validator)).length)
		expect(compactNativeFilter(full.shape.filters.unwrap())).toBeUndefined()
	})

	test('measures the compact scalar projection against the measured size gate', () => {
		const projected = compactNativeFilter(compact.shape.filters.unwrap())!
		const bytes = JSON.stringify(nativeJson(projected)).length
		expect(bytes * 10).toBeLessThan(
			JSON.stringify(nativeJson(full.shape.filters.unwrap().validator)).length,
		)
		expect(bytes).toBeLessThanOrEqual(40 * 1024)
	})

	test('retains every native ID-bearing predicate and variant discriminator', () => {
		const root = compactRoot(idGrammar)
		expect(nativeJson(compactNativeFilter(root)!)).toEqual(nativeJson(root.validator))
	})

	test('compacts ID-free sibling targets while retaining strict and mixed native ID predicates', () => {
		const grammar: FilterGrammar = {
			...idGrammar,
			relations: { ...idGrammar.relations, free: { cardinality: 'many', target } },
			variants: {
				discriminator: 'kind',
				options: { ...idGrammar.variants!.options, free: target },
			},
		}
		const root = compactRoot(grammar)
		const fullJson: any = nativeJson(root.validator)
		const projected: any = nativeJson(compactNativeFilter(root)!)
		const deep = projected.value.not.fieldType.value.not.fieldType
		const baseline = fullJson.value.not.fieldType.value.not.fieldType
		expect(deep.value.variant.fieldType.value.slice(0, 2)).toEqual(
			baseline.value.variant.fieldType.value.slice(0, 2),
		)
		expect(deep.value.variant.fieldType.value[2].value).toEqual({
			tag: { fieldType: { type: 'literal', value: 'free' }, optional: false },
			filters: { fieldType: { type: 'any' }, optional: false },
		})
		expect(deep.value.owner).toEqual(baseline.value.owner)
		expect(deep.value.mixed).toEqual(baseline.value.mixed)
		expect(deep.value.mixed.fieldType.value[0].value).toEqual([
			{ type: 'id', tableName: 'users' },
			{ type: 'string' },
		])
		expect(deep.value.free.fieldType.value).toEqual([
			{ type: 'object', value: { some: { fieldType: { type: 'any' }, optional: false } } },
			{ type: 'object', value: { none: { fieldType: { type: 'any' }, optional: false } } },
		])
	})

	test('falls back for unknown native scalar metadata', () => {
		const unknown = compactRoot({ fields: { opaque: predicate(k.any()) }, relations: {} })
		expect(compactNativeFilter(unknown)).toBeUndefined()
	})
})

const contract = defineFilterContract({
	status: v.union(v.literal('open'), v.literal('done')),
	title: v.string(),
	score: v.number(),
	count: v.optional(v.int64()),
	active: v.boolean(),
	nullable: v.union(v.string(), v.null()),
	reference: v.id('targets'),
})

describe('shared filter contract on k', () => {
	test('one pure declaration supplies bounded scalar filters', () => {
		const c = defineFilterContract({
			status: v.union(v.literal('open'), v.literal('done')),
			count: v.optional(v.int64()),
		})
		expect(c.schema.parse({ status: { in: ['open'] }, count: { exists: false } })).toEqual({
			status: { in: ['open'] },
			count: { exists: false },
		})
		expect(c.schema.safeParse({ status: 'other' }).success).toBe(false)
	})

	test('fields declare a k table with the same native validators', () => {
		const records = kTable('records', contract.fields)
		const stored: Readonly<Record<string, KType>> = records.storage.shape
		for (const [field, expected] of Object.entries(contract.native))
			expect(nativeJson(stored[field].validator)).toEqual(expected.json)
		expect(contract.fields.reference.parse('native-id')).toBe('native-id')
		expect(() => defineFilterContract({ unsupported: v.array(v.string()) })).toThrow('Unsupported')
		expect(() => defineFilterContract({ variant: v.object({ tag: v.string() }) })).toThrow(
			'Unsupported',
		)
	})

	test('descriptors preserve scalar metadata and do not invent date semantics', () => {
		const entries = Object.fromEntries(contract.describe().map((d) => [d.field, d]))
		expect(entries.status).toMatchObject({
			kind: 'enum',
			values: ['open', 'done'],
			operators: ['eq', 'in', 'gt', 'gte', 'lt', 'lte'],
		})
		expect(entries.count).toMatchObject({ kind: 'bigint', optional: true, nullable: false })
		expect(entries.nullable).toMatchObject({
			kind: 'union',
			nullable: true,
			operators: ['eq', 'in'],
		})
		expect(entries.reference).toMatchObject({
			kind: 'id',
			idTables: ['targets'],
			operators: ['eq', 'in'],
		})
		expect(entries.active.kind).toBe('boolean')
		expect(entries.score.kind).toBe('number')
	})

	test('accepts the bounded grammar and rejects raw invalid inputs', () => {
		const valid = [
			{},
			{ status: { in: ['open', 'done'] } },
			{ count: { exists: false } },
			{ count: { gte: 1n, lt: 3n } },
			{ score: { gte: 1, lt: 5 } },
			{ nullable: null },
			{ reference: 'some-id' },
			{ not: { or: [{ active: false }, { title: { gt: 'z' } }] } },
		]
		for (const filters of valid) expect(contract.schema.parse(filters)).toEqual(filters)
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
		for (const filters of invalid)
			expect(contract.schema.safeParse(filters).success, JSON.stringify(filters, replacer)).toBe(
				false,
			)
		expect(JSON.stringify(nativeJson(contract.schema.validator))).toContain('"tableName":"targets"')
	})

	test('three-valued evaluation distinguishes known missing from inaccessible', () => {
		const c = defineFilterContract({ optional: v.optional(v.string()), active: v.boolean() })
		const visible = new Set(['optional', 'active']),
			hidden = new Set(['active'])
		expect(c.evaluate({ optional: { exists: false } }, {}, visible)).toBe(true)
		expect(c.evaluate({ optional: { exists: false } }, {}, hidden)).toBe('unknown')
		expect(c.evaluate({ not: { optional: { exists: false } } }, {}, hidden)).toBe('unknown')
		expect(
			c.evaluate({ and: [{ optional: 'x' }, { active: true }] }, { active: false }, hidden),
		).toBe(false)
		expect(
			c.evaluate({ or: [{ optional: 'x' }, { active: true }] }, { active: true }, hidden),
		).toBe(true)
		expect(c.evaluate({ optional: { exists: false } }, {})).toBe(true)
		expect(c.evaluate({ optional: { eq: 'x' } }, {})).toBe(false)
	})

	test('versioned URL codec canonicalizes keys, retains arrays and bigint, and rejects bounded invalid input', () => {
		const first = contract.searchParam.encode({
			status: { in: ['open', 'done'] },
			count: { gte: 1n },
		})
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
		expect(contract.schema.safeParse(getter).success).toBe(false)
		expect(contract.schema.safeParse(cycle).success).toBe(false)
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
})

describe('laziness (R22)', () => {
	test('importing the filter modules builds no pagination schema until one is requested', async () => {
		vi.resetModules()
		const { k: fresh } = await import('../src/k')
		const { v: values } = await import('convex/values')
		const objects = vi.spyOn(fresh, 'object')
		const natives = vi.spyOn(values, 'object')
		const filters = await import('../src/querying/filters')
		await import('../src/filters')
		await import('../src/table')
		expect(objects).not.toHaveBeenCalled()
		expect(natives).not.toHaveBeenCalled()
		const options = filters.nativePagination()
		expect(filters.nativePagination()).toBe(options)
		expect(objects).toHaveBeenCalledTimes(1)
		expect(natives).not.toHaveBeenCalled()
		const opts = filters.paginationSchemaOf({ name: values.string() }, { name: true })
		expect(natives).not.toHaveBeenCalled()
		expect(nativeJson(opts.validator)).toMatchObject({ type: 'object' })
		expect(natives).toHaveBeenCalled()
		objects.mockRestore()
		natives.mockRestore()
	})
})

function schemaParse(schema: KType, input: unknown) {
	// SAFETY: every KType at runtime is a k schema record with safeParse.
	return (schema as ReturnType<typeof k.any>).safeParse(input)
}

function replacer(_key: string, value: unknown) {
	return typeof value === 'bigint' ? `${value}n` : value
}
