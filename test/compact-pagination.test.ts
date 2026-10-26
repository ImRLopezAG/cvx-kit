import { describe, expect, test } from 'vite-plus/test'
import { z } from 'zod'
import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { queryGeneric } from 'convex/server'
import { NoOp } from 'convex-helpers/server/customFunctions'
import { zid } from 'convex-helpers/server/zod4'
import { zCustomQuery } from '../src/zod-registration'
import { zodTable, zodToConvex } from '../src/zod-table'
import {
	relationFilterSchema,
	scalarPredicateFromSchema,
	compactFilterMetadata,
	paginationGrammar,
	normalizeFilters,
	type FilterGrammar,
} from '../src/querying/shared/filters'

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
const clients = zodTable('clients', () => ({
	status: z.string(),
	lifecycleStage: z.enum(stages),
	email: z.string(),
}))
const predicate = (schema: z.ZodType) => scalarPredicateFromSchema(schema, false, false).optional()
const target: FilterGrammar = { fields: { email: predicate(z.string()) }, relations: {} }
const relationGrammar: FilterGrammar = {
	fields: { status: predicate(z.enum(stages)) },
	relations: { contact: { cardinality: 'one', target }, contacts: { cardinality: 'many', target } },
	variants: { discriminator: 'kind', options: { a: target, b: target } },
}
const idGrammar: FilterGrammar = {
	fields: { owner: predicate(zid('users')), mixed: predicate(z.union([zid('users'), z.string()])) },
	relations: {
		contact: {
			cardinality: 'one',
			target: { fields: { owner: predicate(zid('contacts')) }, relations: {} },
		},
	},
	variants: {
		discriminator: 'kind',
		options: {
			a: { fields: { owner: predicate(zid('users')) }, relations: {} },
			b: { fields: { owner: predicate(zid('contacts')) }, relations: {} },
		},
	},
}
function nativeJson(validator: GenericValidator): ValidatorJSON {
	// SAFETY: Convex native registration reads the runtime validator json getter; declarations mark it internal.
	return (validator as GenericValidator & { readonly json: ValidatorJSON }).json
}
function register(args: z.ZodObject) {
	return zCustomQuery(queryGeneric, NoOp)({ args, handler: () => null })
}
function native(fn: { isConvexFunction: true }): string {
	// SAFETY: actual native registrations expose exportArgs at runtime.
	return (fn as { isConvexFunction: true; exportArgs(): string }).exportArgs()
}
const full = clients.paginationOpts({ status: true, lifecycleStage: true, email: true })
const compact = clients.paginationOpts(
	{ status: true, lifecycleStage: true, email: true },
	{ validator: 'compact' },
)
const fixtures = {
	scalar: full,
	relation: z.object({ filters: relationFilterSchema(relationGrammar).optional() }),
	ids: z.object({ filters: relationFilterSchema(idGrammar).optional() }),
}

describe('compact pagination baseline and boundary', () => {
	test('characterizes actual registered validator bytes for all fixtures', async () => {
		for (const [name, args] of Object.entries(fixtures)) {
			const json = native(register(args))
			expect(JSON.parse(json)).toEqual(nativeJson(zodToConvex(args)))
			if (process.env.ISSUE59_CAPTURE) {
				const { writeFileSync } = await import('node:fs')
				writeFileSync(`${process.env.ISSUE59_CAPTURE}/${name}.json`, json)
			}
		}
	})
	test('compact registered scalar validator fits the measured 40 KiB budget and shrinks at least tenfold', () => {
		const baseline = native(register(full))
		const candidate = native(register(compact))
		expect(candidate.length).toBeLessThanOrEqual(40 * 1024)
		expect(candidate.length * 10).toBeLessThan(baseline.length)
	})
})

describe('compact pagination grammar association', () => {
	test('captures grammar and recovers clone/describe/meta/refine associations', () => {
		const schema = relationFilterSchema(relationGrammar, undefined, { validator: 'compact' })
		const expected = compactFilterMetadata(schema)
		expect(expected).toBeDefined()
		for (const root of [
			schema,
			schema.clone(),
			schema.describe('filter'),
			schema.meta({ title: 'filter' }),
			schema.refine(() => true),
		]) {
			expect(compactFilterMetadata(root)).toBe(expected)
			const args = z
				.object({ filters: root.optional() })
				.extend({ other: z.string().optional() })
				.clone()
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
	})
	test('consumer edits do not mutate captured generated grammar', () => {
		const grammar: FilterGrammar = { fields: { value: predicate(z.string()) }, relations: {} }
		const schema = relationFilterSchema(grammar, undefined, { validator: 'compact' })
		const metadata = compactFilterMetadata(schema)!
		grammar.fields.value = predicate(z.number())
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
		expect(zodToConvex(compact)).toEqual(zodToConvex(full))
	})
})

import { compactNativeFilter } from '../src/querying/filter-boundary'

describe('compact native projection', () => {
	test('retains exact common predicates and IDs while compacting only deep nodes', async () => {
		const compactRoot = compact.shape.filters.unwrap()
		const projected = compactNativeFilter(compactRoot)!
		if (process.env.ISSUE59_CAPTURE) {
			const { writeFileSync } = await import('node:fs')
			for (const [name, root] of Object.entries({
				scalar: compactRoot,
				relation: relationFilterSchema(relationGrammar, undefined, { validator: 'compact' }),
				ids: relationFilterSchema(idGrammar, undefined, { validator: 'compact' }),
			})) {
				writeFileSync(
					`${process.env.ISSUE59_CAPTURE}/candidate-projection-${name}.json`,
					JSON.stringify(nativeJson(compactNativeFilter(root)!)),
				)
			}
		}
		const json = JSON.parse(JSON.stringify(nativeJson(projected)))
		const baseline = JSON.parse(
			JSON.stringify(nativeJson(zodToConvex(full.shape.filters.unwrap()))),
		)
		expect(json.value.status).toEqual(baseline.value.status)
		expect(json.value.fields).toEqual(baseline.value.fields)
		expect(json.value.not.fieldType.value.lifecycleStage).toEqual(
			baseline.value.not.fieldType.value.lifecycleStage,
		)
		expect(json.value.not.fieldType.value.not.fieldType).toEqual({ type: 'any' })
		const idSchema = relationFilterSchema(idGrammar, undefined, { validator: 'compact' })
		const ids = JSON.stringify(nativeJson(compactNativeFilter(idSchema)!))
		expect(ids).toContain('users')
		expect(ids).toContain('contacts')
		expect(ids.length).toBeLessThanOrEqual(JSON.stringify(nativeJson(zodToConvex(idSchema))).length)
		expect(compactNativeFilter(full.shape.filters.unwrap())).toBeUndefined()
	})
	test('measures the compact scalar projection against the measured size gate', () => {
		const projected = compactNativeFilter(compact.shape.filters.unwrap())!
		const bytes = JSON.stringify(nativeJson(projected)).length
		expect(bytes * 10).toBeLessThan(
			JSON.stringify(nativeJson(zodToConvex(full.shape.filters.unwrap()))).length,
		)
		expect(bytes).toBeLessThanOrEqual(40 * 1024)
	})
})

describe('captured definitions and native ID closure', () => {
	test('owns nested scalar definitions and array checks rather than shallow clones', () => {
		const scalar = z.enum(['a', 'b'])
		const membership = z.array(scalar).max(100)
		const grammar: FilterGrammar = {
			fields: {
				value: z.union([scalar, z.object({ in: membership.optional() }).strict()]).optional(),
			},
			relations: {},
		}
		const root = relationFilterSchema(grammar, undefined, { validator: 'compact' })
		const captured = compactFilterMetadata(root)!
		expect(captured.semantic.safeParse({ value: { in: Array(101).fill('a') } }).success).toBe(false)
		Object.assign(scalar._zod.def.entries, { a: 'changed' })
		const check = membership._zod.def.checks![0]
		// SAFETY: this generated array's first check is the max-length check under test.
		if (!(check instanceof z.core.$ZodCheckMaxLength))
			throw new Error('Expected generated membership check')
		check._zod.def.maximum = 200
		expect(captured.semantic.safeParse({ value: 'a' }).success).toBe(true)
		expect(captured.semantic.safeParse({ value: 'changed' }).success).toBe(false)
		expect(captured.semantic.safeParse({ value: { in: Array(101).fill('b') } }).success).toBe(false)
	})
	test('retains every native ID-bearing predicate and variant discriminator at every expression path', () => {
		const root = relationFilterSchema(idGrammar, undefined, { validator: 'compact' })
		const baseline = nativeJson(zodToConvex(root))
		const candidate = nativeJson(compactNativeFilter(root)!)
		function visit(before: any, after: any, path: string) {
			if (before.type === 'id') expect(after, path).toEqual(before)
			if (before.type === 'object')
				for (const [key, field] of Object.entries<any>(before.value)) {
					if (JSON.stringify(field).includes('"type":"id"') || key === 'tag') {
						expect(after.type, path).toBe('object')
						expect(after.value[key].optional, path).toBe(field.optional)
						visit(field.fieldType, after.value[key].fieldType, `${path}.${key}`)
					}
				}
			if (before.type === 'union' && JSON.stringify(before).includes('"type":"id"')) {
				expect(after.type, path).toBe('union')
				expect(after.value.length, path).toBe(before.value.length)
				before.value.forEach((v: any, i: number) => visit(v, after.value[i], `${path}|${i}`))
			}
			if (before.type === 'array' && JSON.stringify(before).includes('"type":"id"'))
				visit(before.value, after.value, `${path}[]`)
			if (before.type === 'literal') expect(after, path).toEqual(before)
		}
		visit(baseline, candidate, 'root')
		expect(candidate).toEqual(baseline)
	})
})

test('falls back for unknown native scalar metadata and changed object policies', () => {
	const unknown = relationFilterSchema(
		{ fields: { opaque: predicate(z.custom(() => true)) }, relations: {} },
		undefined,
		{ validator: 'compact' },
	)
	expect(compactNativeFilter(unknown)).toBeUndefined()
	const root = relationFilterSchema(relationGrammar, undefined, { validator: 'compact' })
	// SAFETY: generated relation filters are object schemas, exposed broadly to keep the full recursive public type.
	const object = root as z.ZodObject
	expect(compactNativeFilter(object.passthrough())).toBeUndefined()
	object.shape.status = predicate(z.string())
	expect(compactNativeFilter(object)).toBeUndefined()
})

test('compacts ID-free sibling targets while retaining strict and mixed native ID predicates', () => {
	const grammar: FilterGrammar = {
		...idGrammar,
		relations: { ...idGrammar.relations, free: { cardinality: 'many', target } },
		variants: { discriminator: 'kind', options: { ...idGrammar.variants!.options, free: target } },
	}
	const root = relationFilterSchema(grammar, undefined, { validator: 'compact' })
	const full: any = nativeJson(zodToConvex(root))
	const projected: any = nativeJson(compactNativeFilter(root)!)
	const deep = projected.value.not.fieldType.value.not.fieldType
	const baseline = full.value.not.fieldType.value.not.fieldType
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
	expect(deep.value.variant.fieldType.value.map((branch: any) => branch.value.tag)).toEqual(
		baseline.value.variant.fieldType.value.map((branch: any) => branch.value.tag),
	)
})

test('records paired actual registration sizes for scalar relation/variant and ID floor fixtures', async () => {
	const candidates = {
		scalar: compact,
		relation: z.object({
			filters: relationFilterSchema(relationGrammar, undefined, {
				validator: 'compact',
			}).optional(),
		}),
		ids: z.object({
			filters: relationFilterSchema(idGrammar, undefined, { validator: 'compact' }).optional(),
		}),
	}
	for (const name of ['scalar', 'relation', 'ids'] as const) {
		const baseline = native(register(fixtures[name]))
		const candidate = native(register(candidates[name]))
		if (name === 'ids') expect(candidate.length).toBeLessThanOrEqual(baseline.length)
		else expect(candidate.length * 10).toBeLessThan(baseline.length)
		if (process.env.ISSUE59_CAPTURE) {
			const { writeFileSync } = await import('node:fs')
			writeFileSync(`${process.env.ISSUE59_CAPTURE}/baseline-${name}.json`, baseline)
			writeFileSync(`${process.env.ISSUE59_CAPTURE}/candidate-registered-${name}.json`, candidate)
		}
	}
})

test('retains exact predicates through both namespaces on every common relation variant and boolean edge', () => {
	const root = relationFilterSchema(
		{
			...relationGrammar,
			fields: {
				...relationGrammar.fields,
				and: predicate(z.string()),
				fields: predicate(z.string()),
				variant: predicate(z.string()),
			},
		},
		undefined,
		{ validator: 'compact' },
	)
	const before: any = nativeJson(zodToConvex(root)),
		after: any = nativeJson(compactNativeFilter(root)!)
	function predicates(a: any, b: any) {
		for (const key of ['status', 'email', 'fields'])
			if (a.value[key]) expect(b.value[key]).toEqual(a.value[key])
	}
	predicates(before, after)
	for (const key of ['and', 'or'])
		predicates(before.value[key].fieldType.value, after.value[key].fieldType.value)
	predicates(before.value.not.fieldType, after.value.not.fieldType)
	predicates(before.value.contact.fieldType.value[0], after.value.contact.fieldType.value[0])
	for (const [index, key] of ['some', 'none'].entries())
		predicates(
			before.value.contacts.fieldType.value[index].value[key].fieldType,
			after.value.contacts.fieldType.value[index].value[key].fieldType,
		)
	for (const [index, branch] of before.value.variant.fieldType.value.entries()) {
		expect(after.value.variant.fieldType.value[index].value.tag).toEqual(branch.value.tag)
		predicates(
			branch.value.filters.fieldType,
			after.value.variant.fieldType.value[index].value.filters.fieldType,
		)
	}
})

test('uses full conversion for generated capture forms it cannot isolate', () => {
	const lazy = relationFilterSchema(
		{ fields: { value: predicate(z.lazy(() => z.string())) }, relations: {} },
		undefined,
		{ validator: 'compact' },
	)
	expect(compactFilterMetadata(lazy)).toBeUndefined()
	expect(compactNativeFilter(lazy)).toBeUndefined()
	const checked = relationFilterSchema(
		{ fields: { value: predicate(z.string().regex(/^a/)) }, relations: {} },
		undefined,
		{ validator: 'compact' },
	)
	expect(compactFilterMetadata(checked)).toBeUndefined()
	expect(compactNativeFilter(checked)).toBeUndefined()
})
