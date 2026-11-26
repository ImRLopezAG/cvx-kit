/* oxlint-disable anti-slop/no-runtime-typeof -- The filter budget preflight classifies undecoded values by representation before any schema walk reads them. */
import type { PropertyValidators, VObject } from 'convex/values'
import { k, type KCheckContext, type KSchema, type KType } from '../../k'
import { KAny } from '../../k/kinds'
import type { FilterAst, FilterScalar, FilterOperator } from './ast'

export const MAX_FILTER_DEPTH = 4
export const MAX_FILTER_NODES = 256
export const MAX_FILTER_IN_VALUES = 100

/** A filter predicate per field name; each is a `k` schema. */
export type FieldSchemas = Record<string, KType>

export type FilterTree =
	| string
	| number
	| bigint
	| boolean
	| null
	| undefined
	| FilterTree[]
	| { [key: string]: FilterTree }

/**
 * Each boolean child and relation target expression consumes one of four edges. some/none wrappers
 * and fields namespaces consume nodes, but no extra depth. `Field` is the predicate schema type; the
 * engine's own grammars use `k` schemas, and the structure-only readers accept any.
 */
export interface FilterGrammarOf<Field> {
	fields: Record<string, Field>
	variants?: { discriminator: string; options: Record<string, FilterGrammarOf<Field>> }
	relations: Record<string, { cardinality: 'one' | 'many'; target: FilterGrammarOf<Field> }>
}

export type FilterGrammar = FilterGrammarOf<KType>

export interface PaginationValidatorOptions {
	validator: 'compact'
}

/**
 * A filter boundary: a `k` schema whose native validator is the full structural filter validator and
 * whose parse first runs the layout and depth/node budget preflight, then the structural walk. Its
 * output is its input: filters declare no defaults or transforms. Like every `k` schema, both sides
 * carry native ID brands, as the native validator does.
 */
export type KFilterSchema<Filters = FilterTree> = KSchema<
	Filters,
	VObject<Filters, PropertyValidators>
>

export interface FilterBoundaryMetadata {
	readonly grammar: FilterGrammar
	readonly semantic: KFilterSchema
}

/** Only boundaries created here can carry permission to project a filter. */
export function compactFilterMetadata(schema: KType): FilterBoundaryMetadata | undefined {
	const record = boundaryRecord(schema)
	return record && compactFilters.get(record)
}

/** Only library-owned field getters may stay deferred when a compact grammar is captured. */
const deferredPredicates = new WeakSet<() => KType>()

export function deferFilterField(fields: FieldSchemas, name: string, build: () => KType): void {
	let schema: KType | undefined
	const get = () => (schema ??= build())
	deferredPredicates.add(get)
	Object.defineProperty(fields, name, { enumerable: true, get })
}

export function relationFilterSchema(
	grammar: FilterGrammar,
	cache: FilterNodeCache = new WeakMap(),
	options?: PaginationValidatorOptions,
): KFilterSchema {
	if (options?.validator !== 'compact')
		return boundedFilter(() => filterNodeSchema(grammar, 0, cache), grammar)
	// k records are immutable, so a frozen copy of the grammar's structure is all a compact
	// boundary needs to stay independent of later edits to the caller's grammar objects.
	const captured = captureGrammar(grammar)
	const schema = boundedFilter(() => filterNodeSchema(captured, 0), captured)
	compactFilters.set(schema, Object.freeze({ grammar: captured, semantic: schema }))
	return schema
}

/**
 * The engine's private filter boundary. It accepts exactly what relationFilterSchema(grammar) accepts,
 * but builds relation predicates only for the relations an input names: absent optional relations
 * validate nothing. So a query never reads relation grammars, or their tables, that it does not use.
 */
export function lazyRelationFilterSchema(
	grammar: FilterGrammar,
	cache: FilterNodeCache = new WeakMap(),
): KFilterSchema {
	const restricted = new Map<string, FilterGrammar>()
	const ids = new WeakMap<FilterGrammar, number>()
	let nextId = 0
	function idOf(source: FilterGrammar): number {
		let id = ids.get(source)
		if (id === undefined) ids.set(source, (id = nextId++))
		return id
	}
	// A restriction is a function of the root grammar and the relation names used per grammar, so
	// that flat set is its key: no larger than the input.
	function restrict(used: Map<FilterGrammar, Set<string>>): FilterGrammar {
		const key = used.size
			? JSON.stringify(
					[...used]
						.map(([source, names]) => [idOf(source), [...names].sort()] as const)
						.sort(([a], [b]) => a - b),
				)
			: ''
		let result = restricted.get(key)
		if (!result) {
			result = build(used, grammar, 0, new Map())
			if (restricted.size >= 256) restricted.clear()
			restricted.set(key, result)
		}
		return result
	}
	// One restricted grammar per source grammar and depth. filterNodeSchema builds no relations at
	// MAX_FILTER_DEPTH, so neither does a restriction; this also bounds the walk over a cyclic grammar.
	function build(
		used: Map<FilterGrammar, Set<string>>,
		source: FilterGrammar,
		depth: number,
		states: Map<string, FilterGrammar>,
	): FilterGrammar {
		const state = `${idOf(source)}:${depth}`
		const existing = states.get(state)
		if (existing) return existing
		const result: FilterGrammar = { fields: source.fields, relations: {} }
		states.set(state, result)
		if (depth < MAX_FILTER_DEPTH)
			for (const name of [...(used.get(source) ?? [])].sort()) {
				const relation = source.relations[name]
				result.relations[name] = {
					cardinality: relation.cardinality,
					target: build(used, relation.target, depth + 1, states),
				}
			}
		if (source.variants)
			result.variants = {
				discriminator: source.variants.discriminator,
				options: Object.fromEntries(
					Object.entries(source.variants.options).map(([tag, option]) => [
						tag,
						build(used, option, depth + 1, states),
					]),
				),
			}
		return result
	}
	return boundedFilter(
		() => filterNodeSchema(restrict(new Map()), 0, cache),
		grammar,
		// Validate against the relations this input names; the rest are absent.
		(used) => filterNodeSchema(restrict(used), 0, cache),
	)
}

/** The grammar of a pagination object's `filters` field, when a boundary created here supplies it. */
export function paginationGrammar(schema: KType): FilterGrammar | undefined {
	const fields = objectFields(schema)
	const filters = fields?.filters
	const root = filters?.op === 'optional' ? previous(filters) : null
	if (root === null) return undefined
	const record = boundaryRecord(root)
	if (record) return filterGrammars.get(record)
	const nodeFields = objectFields(root)
	if (!nodeFields) return undefined
	const variant = nodeFields.variant
	return {
		fields: nodeFields,
		variants: variant === undefined ? undefined : variantPredicates.get(variant),
		relations: Object.fromEntries(
			Object.entries(nodeFields).flatMap(([name, predicate]) => {
				const relation = relationPredicates.get(predicate)
				return relation ? [[name, relation]] : []
			}),
		),
	}
}

export function normalizeFilters(value: FilterTree, grammar?: FilterGrammarOf<unknown>): FilterAst {
	const children: FilterAst[] = []
	if (!value) return { kind: 'and', children }
	// SAFETY: the caller parsed a strict filter object; its grammar has no array/primitive expression.
	const expression = value as Record<string, FilterTree>
	for (const [name, predicate] of Object.entries(expression)) {
		if (predicate === undefined) continue
		if (name === 'and' || name === 'or') {
			// SAFETY: boolean composition is validated as an array of expressions.
			children.push({
				kind: name,
				children: (predicate as FilterTree[]).map((child) => normalizeFilters(child, grammar)),
			})
		} else if (name === 'variant' && grammar?.variants) {
			// SAFETY: strict branch grammar validates the literal tag and its selected target filters.
			const scoped = predicate as { tag: string; filters: FilterTree }
			children.push({
				kind: 'variant',
				discriminator: grammar.variants.discriminator,
				tag: scoped.tag,
				child: normalizeFilters(scoped.filters, grammar.variants.options[scoped.tag]),
			})
		} else if (name === 'not')
			children.push({ kind: 'not', child: normalizeFilters(predicate, grammar) })
		else if (name === 'fields') {
			// SAFETY: fields is a strict selected scalar namespace.
			for (const [field, scalar] of Object.entries(predicate as Record<string, FilterTree>))
				children.push(...normalizeScalar(field, scalar))
		} else if (grammar?.relations[name]) {
			const relation = grammar.relations[name]
			if (relation.cardinality === 'one')
				children.push({
					kind: 'relation',
					name,
					mode: 'one',
					predicate: predicate === null ? null : normalizeFilters(predicate, relation.target),
				})
			else {
				// SAFETY: many predicates validate as exactly one some/none target expression.
				const target = predicate as { some?: FilterTree; none?: FilterTree }
				children.push({
					kind: 'relation',
					name,
					mode: target.some === undefined ? 'none' : 'some',
					predicate: normalizeFilters(target.some ?? target.none, relation.target),
				})
			}
		} else children.push(...normalizeScalar(name, predicate))
	}
	return { kind: 'and', children }
}

/** The predicate for one scalar field: the value itself, or a non-empty operator object. */
export function scalarPredicateFromSchema(scalar: KType, range: boolean, optional: boolean): KType {
	const value = schemaOf(scalar)
	const operators = Object.fromEntries([
		['eq', value.optional()],
		['in', k.array(value).max(MAX_FILTER_IN_VALUES).optional()],
		...(range ? RANGE_OPERATORS.map((name) => [name, value.optional()] as const) : []),
		...(optional ? [['exists', k.boolean().optional()] as const] : []),
	])
	return unionOf([
		value,
		k
			.object(operators)
			.refine(
				(entries) => Object.values(entries).some((entry) => entry !== undefined),
				'At least one operator is required',
			),
	])
}

export function boundedFilterSchema(
	predicates: FieldSchemas,
	options?: PaginationValidatorOptions,
): KFilterSchema {
	return relationFilterSchema({ fields: predicates, relations: {} }, undefined, options)
}

/** Union of `k` schemas, including the one-member union v1's Zod conversion produced natively. */
export function unionOf(members: readonly KType[]): KType {
	// SAFETY: k.union stores any member list; v1 emitted a native union for every member count.
	return k.union(members as readonly [KType, KType])
}

type FilterNodeCache = WeakMap<FilterGrammar, Map<number, KType>>

/** Operators a scalar predicate accepts only where the field's values are ordered. */
const RANGE_OPERATORS = ['gt', 'gte', 'lt', 'lte'] as const

const BUDGET_MESSAGE = 'Unsupported filter layout or depth/node budget exceeded'

/** Boundary records, by the grammar their budget preflight reads. */
const filterGrammars = new WeakMap<KType, FilterGrammar>()
/** Compact-capable boundaries and their captured grammar. */
const compactFilters = new WeakMap<KType, FilterBoundaryMetadata>()
/** Generated relation and variant predicates, so a structural object's grammar can be recovered. */
const relationPredicates = new WeakMap<
	KType,
	{ cardinality: 'one' | 'many'; target: FilterGrammar }
>()
const variantPredicates = new WeakMap<KType, NonNullable<FilterGrammar['variants']>>()

/** Ops a boundary may carry above its own record without changing what it validates natively. */
const TRANSPARENT_OPS: ReadonlySet<string> = new Set(['describe', 'refine', 'check'])

/**
 * The boundary: a private `k.any()` root whose native validator is the lazily built structural one,
 * and a `check` on it that runs the budget preflight before the structural walk. Wrappers chained on
 * the result (optional, nullable, describe) compile natively from that root, so they all export the
 * structural validator, and the check runs on both the full walk and the plan-only path (KTD3).
 */
function boundedFilter(
	build: () => KType,
	grammar: FilterGrammar,
	resolve?: (used: Map<FilterGrammar, Set<string>>) => KType,
): KFilterSchema {
	let structural: KType | undefined
	function structure(): KType {
		return (structural ??= build())
	}
	const root = new KAny(null, 'any', undefined, undefined)
	// SAFETY: `native` is the root's memo slot for its native validator; compileNative and the
	// `validator` getter only read it, so supplying it lazily keeps declaration free of native work.
	Object.defineProperty(root, 'native', {
		get: () => structure().validator,
		enumerable: true,
		configurable: true,
	})
	const record = root.check((value: FilterTree, context: KCheckContext) => {
		const used = resolve && new Map<FilterGrammar, Set<string>>()
		if (!withinFilterBudget(value, grammar, used)) {
			context.addIssue({ code: 'custom', message: BUDGET_MESSAGE })
			return
		}
		const parsed = schemaOf(used && resolve ? resolve(used) : structure()).safeParse(value)
		if (!parsed.success) for (const issue of parsed.issues) context.addIssue(issue)
	})
	filterGrammars.set(record, grammar)
	return filterSchemaOf(record)
}

function filterNodeSchema(
	grammar: FilterGrammar,
	depth: number,
	cache: FilterNodeCache = new WeakMap(),
): KType {
	const cached = cache.get(grammar)?.get(depth)
	if (cached) return cached
	const predicates = grammar.fields
	const controls = new Set(['and', 'or', 'not', 'fields', ...(grammar.variants ? ['variant'] : [])])
	const direct = Object.fromEntries(
		Object.entries(predicates).filter(([key]) => !controls.has(key)),
	)
	const relations: Record<string, KType> = {}
	for (const [name, relation] of Object.entries(grammar.relations)) {
		if (depth === MAX_FILTER_DEPTH) continue
		const target = schemaOf(filterNodeSchema(relation.target, depth + 1, cache))
		const predicate = schemaOf(
			relation.cardinality === 'one'
				? target.nullable()
				: unionOf([k.object({ some: target }), k.object({ none: target })]),
		).optional()
		relations[name] = predicate
		relationPredicates.set(predicate, relation)
	}
	if (grammar.variants && depth < MAX_FILTER_DEPTH) {
		const options = Object.entries(grammar.variants.options).map(([tag, branch]) =>
			k.object({ tag: k.literal(tag), filters: filterNodeSchema(branch, depth + 1, cache) }),
		)
		if (options.length) {
			const variant = schemaOf(unionOf(options)).optional()
			relations.variant = variant
			variantPredicates.set(variant, grammar.variants)
		}
	}
	const node = k.object({
		...direct,
		...relations,
		fields: k.object(predicates).optional(),
	})
	const child =
		depth === MAX_FILTER_DEPTH ? undefined : schemaOf(filterNodeSchema(grammar, depth + 1, cache))
	const result = child
		? node.extend({
				and: k.array(child).min(1).max(MAX_FILTER_NODES).optional(),
				or: k.array(child).min(1).max(MAX_FILTER_NODES).optional(),
				not: child.optional(),
			})
		: node
	let depths = cache.get(grammar)
	if (!depths) {
		depths = new Map()
		cache.set(grammar, depths)
	}
	depths.set(depth, result)
	return result
}

function withinFilterBudget(
	value: FilterTree,
	grammar: FilterGrammar,
	used?: Map<FilterGrammar, Set<string>>,
): boolean {
	type Context =
		| 'expression'
		| 'fields'
		| 'predicate'
		| 'composition'
		| 'many'
		| 'variant'
		| 'value'
	interface Entry {
		value: FilterTree
		depth: number
		context: Context
		grammar: FilterGrammar
	}
	const pending: Entry[] = [{ value, depth: 0, context: 'expression', grammar }]
	let nodes = 0
	while (pending.length) {
		const entry = pending.pop()!
		if (++nodes > MAX_FILTER_NODES || entry.depth > MAX_FILTER_DEPTH) return false
		if (Object(entry.value) !== entry.value) continue
		// SAFETY: boxing excludes null and primitives; descriptors below avoid invoking getters.
		const object = entry.value as FilterTree[] | Record<string, FilterTree>
		const array = Array.isArray(object) ? object : undefined
		const prototype = Object.getPrototypeOf(object)
		if (
			array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
		)
			return false
		if (array && array.length + nodes + pending.length > MAX_FILTER_NODES) return false
		const keys = Reflect.ownKeys(object)
		if (
			keys.length - (array ? 1 : 0) + nodes + pending.length > MAX_FILTER_NODES ||
			(array && keys.length !== array.length + 1)
		)
			return false
		let consumed: string[]
		switch (entry.context) {
			case 'expression':
				consumed = [
					...Object.keys(entry.grammar.fields),
					...Object.keys(entry.grammar.relations),
					'and',
					'or',
					'not',
					'fields',
					...(entry.grammar.variants ? ['variant'] : []),
				]
				break
			case 'variant':
				consumed = ['tag', 'filters']
				break
			case 'fields':
				consumed = Object.keys(entry.grammar.fields)
				break
			case 'predicate':
				consumed = ['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'exists']
				break
			case 'many':
				consumed = ['some', 'none']
				break
			default:
				consumed = []
		}
		for (const key of consumed) if (!Object.hasOwn(object, key) && key in object) return false
		for (const key of keys) {
			if (array && key === 'length') continue
			const descriptor = Object.getOwnPropertyDescriptor(object, key)!
			const name = String(key)
			if (!descriptor.enumerable || !('value' in descriptor) || name !== key) return false
			if (array && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= array.length)) return false
			let context: Context = 'value'
			let depth = entry.depth
			let target = entry.grammar
			if (entry.context === 'expression') {
				context = 'predicate'
				if (name === 'variant' && entry.grammar.variants) {
					context = 'variant'
					depth++
				} else if (name === 'fields') context = 'fields'
				else if (name === 'and' || name === 'or') {
					context = 'composition'
					depth++
				} else if (name === 'not') {
					context = 'expression'
					depth++
				} else if (Object.hasOwn(entry.grammar.relations, name)) {
					const relation = entry.grammar.relations[name]
					context = relation.cardinality === 'one' ? 'expression' : 'many'
					target = relation.target
					depth++
					if (used) {
						const names = used.get(entry.grammar) ?? new Set<string>()
						used.set(entry.grammar, names.add(name))
					}
				}
			} else if (entry.context === 'variant' && name === 'filters') {
				const tag = Object.getOwnPropertyDescriptor(object, 'tag')
				if (
					!tag ||
					!('value' in tag) ||
					typeof tag.value !== 'string' ||
					!Object.hasOwn(entry.grammar.variants?.options ?? {}, tag.value)
				)
					return false
				context = 'expression'
				target = entry.grammar.variants!.options[tag.value]
			} else if (entry.context === 'fields') context = 'predicate'
			else if (entry.context === 'composition' || entry.context === 'many') context = 'expression'
			pending.push({ value: descriptor.value, depth, context, grammar: target })
		}
	}
	return true
}

function normalizeScalar(field: string, predicate: FilterTree): FilterAst[] {
	if (predicate === undefined) return []
	if (Object(predicate) !== predicate) {
		// SAFETY: native scalar grammar excludes object/array values and preserves branded ID strings.
		return [{ kind: 'scalar', field, operator: 'eq', value: predicate as FilterScalar }]
	}
	// SAFETY: only selected supported scalar operator objects survive validation.
	return Object.entries(predicate as Record<FilterOperator, FilterScalar | FilterScalar[]>)
		.filter(([, value]) => value !== undefined)
		.map(([operator, value]) => ({
			kind: 'scalar',
			field,
			operator: operator as FilterOperator,
			value,
		}))
}

/** The record a boundary was created as, below any transparent records chained on it. */
function boundaryRecord(schema: KType): KType | undefined {
	for (let current: KType | null = schema; current !== null; current = previous(current)) {
		if (filterGrammars.has(current)) return current
		if (!TRANSPARENT_OPS.has(current.op)) return undefined
	}
	return undefined
}

/** The field map of an object schema, through validation-only records chained on its root. */
function objectFields(schema: KType): Readonly<Record<string, KType>> | undefined {
	let current: KType = schema
	while (current.prev !== null) {
		if (!TRANSPARENT_OPS.has(current.op) && current.op !== 'strip') return undefined
		current = previous(current) ?? current
	}
	if (current.op !== 'object') return undefined
	// SAFETY: k.object stores its field map as the root argument.
	return current.arg as Readonly<Record<string, KType>>
}

function filterSchemaOf(record: KType): KFilterSchema {
	// SAFETY: the record's validator is the structural filter object and its parse yields its input.
	return record as KFilterSchema
}

function previous(schema: KType): KType | null {
	// SAFETY: every record reachable from a k schema was created by a k factory.
	return schema.prev as KType | null
}

function schemaOf(schema: KType): KSchema<any, any, any, any, any> {
	// SAFETY: every KType at runtime is a KSchema record created by a k factory.
	return schema as KSchema<any, any, any, any, any>
}

/** Freeze a copy of the grammar's structure, reading every relation getter once. */
function captureGrammar(
	source: FilterGrammar,
	seen = new WeakMap<FilterGrammar, FilterGrammar>(),
): FilterGrammar {
	const cached = seen.get(source)
	if (cached) return cached
	const fields: FieldSchemas = {}
	for (const key of Object.keys(source.fields)) {
		const descriptor = Object.getOwnPropertyDescriptor(source.fields, key)!
		// Caller-owned getters still snapshot now; only our immutable lazy predicates defer reads.
		Object.defineProperty(
			fields,
			key,
			descriptor.get && deferredPredicates.has(descriptor.get)
				? descriptor
				: { enumerable: true, value: source.fields[key] },
		)
	}
	const result: FilterGrammar = { fields: Object.freeze(fields), relations: {} }
	seen.set(source, result)
	result.relations = Object.freeze(
		Object.fromEntries(
			Object.entries(source.relations).map(([name, relation]) => [
				name,
				Object.freeze({
					cardinality: relation.cardinality,
					target: captureGrammar(relation.target, seen),
				}),
			]),
		),
	)
	if (source.variants)
		result.variants = Object.freeze({
			discriminator: source.variants.discriminator,
			options: Object.freeze(
				Object.fromEntries(
					Object.entries(source.variants.options).map(([tag, option]) => [
						tag,
						captureGrammar(option, seen),
					]),
				),
			),
		})
	return Object.freeze(result)
}
