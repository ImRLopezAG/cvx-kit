import { z } from 'zod'
import type { FilterAst, FilterScalar, FilterOperator } from './ast'
export const MAX_FILTER_DEPTH = 4
export const MAX_FILTER_NODES = 256
export const MAX_FILTER_IN_VALUES = 100
export type FieldSchemas = Record<string, z.ZodType>
export type FilterTree =
	| string
	| number
	| bigint
	| boolean
	| null
	| undefined
	| FilterTree[]
	| { [key: string]: FilterTree }

// Compose Zod's exported core constructor with its ordinary object initializer.
// Clones use this constructor again, preserving preflight without replacing the
// converter-recognized object definition or any native scalar/ID validators.
const relationPredicates = new WeakMap<
	z.core.$ZodType,
	{ cardinality: 'one' | 'many'; target: FilterGrammar }
>()
const variantPredicates = new WeakMap<z.core.$ZodType, NonNullable<FilterGrammar['variants']>>()
const filterGrammars = new WeakMap<z.core.$ZodType, FilterGrammar>()

export interface PaginationValidatorOptions {
	validator: 'compact'
}

export interface FilterBoundaryMetadata {
	readonly grammar: FilterGrammar
	readonly semantic: z.ZodType
}
const compactFilters = new WeakMap<
	z.core.$ZodType,
	{
		metadata: FilterBoundaryMetadata
		matches(): boolean
	}
>()

/** Only constructors created here can carry permission to project a filter. */
export function compactFilterMetadata(schema: z.core.$ZodType): FilterBoundaryMetadata | undefined {
	const entry = compactFilters.get(schema)
	return entry?.matches() ? entry.metadata : undefined
}

/** Each boolean child and relation target expression consumes one of four edges.
 * some/none wrappers and fields namespaces consume nodes, but no extra depth.
 */
export interface FilterGrammar {
	fields: FieldSchemas
	variants?: { discriminator: string; options: Record<string, FilterGrammar> }
	relations: Record<string, { cardinality: 'one' | 'many'; target: FilterGrammar }>
}

export function relationFilterSchema(
	grammar: FilterGrammar,
	cache = new WeakMap<FilterGrammar, Map<number, z.ZodObject>>(),
	options?: PaginationValidatorOptions,
): z.ZodType {
	if (options?.validator === 'compact') {
		let captured: FilterGrammar
		try {
			captured = captureGrammar(grammar)
		} catch (error) {
			if (!(error instanceof UnsupportedFilterCapture)) throw error
			return boundedObject(filterNodeSchema(grammar, 0, cache)._zod.def, grammar)
		}
		const semantic = boundedObject(filterNodeSchema(captured, 0)._zod.def, captured)
		return boundedObject(
			filterNodeSchema(grammar, 0, cache)._zod.def,
			captured,
			Object.freeze({ grammar: captured, semantic }),
		)
	}
	return boundedObject(filterNodeSchema(grammar, 0, cache)._zod.def, grammar)
}

/**
 * The engine's private filter boundary. It accepts exactly what
 * relationFilterSchema(grammar) accepts, but builds relation predicates only for
 * the relations an input names: absent optional relations validate nothing. So
 * a query never reads relation grammars, or their tables, that it does not use.
 */
export function lazyRelationFilterSchema(
	grammar: FilterGrammar,
	cache = new WeakMap<FilterGrammar, Map<number, z.ZodObject>>(),
): z.ZodType {
	const restricted = new Map<string, FilterGrammar>()
	const ids = new WeakMap<FilterGrammar, number>()
	let nextId = 0
	const idOf = (source: FilterGrammar) => {
		let id = ids.get(source)
		if (id === undefined) ids.set(source, (id = nextId++))
		return id
	}
	// A restriction is a function of the root grammar and the relation names used
	// per grammar, so that flat set is its key: no larger than the input.
	function restrict(used: Map<FilterGrammar, Set<string>>): FilterGrammar {
		const key = JSON.stringify(
			[...used]
				.map(([source, names]) => [idOf(source), [...names].sort()] as const)
				.sort(([a], [b]) => a - b),
		)
		let result = restricted.get(key)
		if (!result) {
			result = build(used, grammar, 0, new Map())
			if (restricted.size >= 256) restricted.clear()
			restricted.set(key, result)
		}
		return result
	}
	// One restricted grammar per source grammar and depth. filterNodeSchema builds
	// no relations at MAX_FILTER_DEPTH, so neither does a restriction; this also
	// bounds the walk over a cyclic grammar.
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
	const scalar = restrict(new Map())
	return boundedObject(filterNodeSchema(scalar, 0, cache)._zod.def, grammar, undefined, (used) =>
		filterNodeSchema(restrict(used), 0, cache),
	)
}

export function paginationGrammar(schema: z.ZodType): FilterGrammar | undefined {
	if (!(schema instanceof z.ZodObject)) return undefined
	const filters = schema.shape.filters
	if (!(filters instanceof z.ZodOptional)) return undefined
	const root = filters.unwrap()
	const cached = filterGrammars.get(root)
	if (cached) return cached
	if (!(root instanceof z.ZodObject)) return undefined
	return {
		fields: root.shape,
		variants: variantPredicates.get(root.shape.variant),
		relations: Object.fromEntries(
			Object.entries(root.shape).flatMap(([name, predicate]) => {
				// SAFETY: object shapes contain Zod schemas; metadata only recognizes predicates created by our grammar.
				const relation = relationPredicates.get(predicate as z.core.$ZodType)
				return relation ? [[name, relation]] : []
			}),
		),
	}
}
export function normalizeFilters(value: FilterTree, grammar?: FilterGrammar): FilterAst {
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
export function scalarPredicateFromSchema(
	scalar: z.ZodType,
	range: boolean,
	optional: boolean,
): z.ZodType {
	const equality = z.object({
		eq: scalar.optional(),
		in: z.array(scalar).max(MAX_FILTER_IN_VALUES).optional(),
	})
	const ranged = range
		? equality.extend({
				gt: scalar.optional(),
				gte: scalar.optional(),
				lt: scalar.optional(),
				lte: scalar.optional(),
			})
		: equality
	const existence = optional ? ranged.extend({ exists: z.boolean().optional() }) : ranged
	return z.union([
		scalar,
		existence
			.strict()
			.refine(
				(value) => Object.values(value).some((entry) => entry !== undefined),
				'At least one operator is required',
			),
	])
}

export function boundedFilterSchema(
	predicates: FieldSchemas,
	options?: PaginationValidatorOptions,
): z.ZodType {
	return relationFilterSchema({ fields: predicates, relations: {} }, undefined, options)
}

function filterNodeSchema(
	grammar: FilterGrammar,
	depth: number,
	cache = new WeakMap<FilterGrammar, Map<number, z.ZodObject>>(),
): z.ZodObject {
	const cached = cache.get(grammar)?.get(depth)
	if (cached) return cached
	const predicates = grammar.fields
	const direct = Object.fromEntries(
		Object.entries(predicates).filter(
			([key]) =>
				!['and', 'or', 'not', 'fields', ...(grammar.variants ? ['variant'] : [])].includes(key),
		),
	)
	const relations: FieldSchemas = {}
	for (const [name, relation] of Object.entries(grammar.relations)) {
		if (depth === MAX_FILTER_DEPTH) continue
		const target = filterNodeSchema(relation.target, depth + 1, cache)
		relations[name] = (
			relation.cardinality === 'one'
				? target.nullable()
				: z.union([z.object({ some: target }).strict(), z.object({ none: target }).strict()])
		).optional()
		relationPredicates.set(relations[name], relation)
	}
	if (grammar.variants && depth < MAX_FILTER_DEPTH) {
		const options = Object.entries(grammar.variants.options).map(([tag, branch]) =>
			z.strictObject({ tag: z.literal(tag), filters: filterNodeSchema(branch, depth + 1, cache) }),
		)
		if (options.length) {
			relations.variant = z.union(options).optional()
			variantPredicates.set(relations.variant, grammar.variants)
		}
	}
	const node = z
		.object({ ...direct, ...relations, fields: z.object(predicates).strict().optional() })
		.strict()
	const child = depth === MAX_FILTER_DEPTH ? undefined : filterNodeSchema(grammar, depth + 1, cache)
	const result = child
		? node.extend({
				and: z.array(child).min(1).max(MAX_FILTER_NODES).optional(),
				or: z.array(child).min(1).max(MAX_FILTER_NODES).optional(),
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
					!z.string().safeParse(tag.value).success ||
					!Object.hasOwn(entry.grammar.variants?.options ?? {}, tag.value)
				)
					return false
				context = 'expression'
				target = entry.grammar.variants!.options[String(tag.value)]
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

function boundedObject(
	definition: z.ZodObject['_zod']['def'],
	grammar: FilterGrammar,
	metadata?: FilterBoundaryMetadata,
	resolve?: (used: Map<FilterGrammar, Set<string>>) => z.ZodObject,
): z.ZodObject {
	const expected = Object.entries(definition.shape)
	const expectedCatchall = definition.catchall
	const BoundedFilterObject = z.core.$constructor<z.ZodObject>(
		'BoundedFilterObject',
		(inst, def) => {
			z.ZodObject.init(inst, def)
			filterGrammars.set(inst, grammar)
			// Clones/refinements retain the generated fields. Shape edits use full conversion.
			if (
				metadata &&
				def.catchall === expectedCatchall &&
				Object.keys(def.shape).length === expected.length &&
				expected.every(([key, value]) => def.shape[key] === value)
			)
				compactFilters.set(inst, {
					metadata,
					matches: () =>
						inst._zod.def.catchall === expectedCatchall &&
						Object.keys(inst._zod.def.shape).length === expected.length &&
						expected.every(([key, value]) => inst._zod.def.shape[key] === value),
				})
			const parse = inst._zod.parse
			inst._zod.parse = (payload, ctx) => {
				const used = resolve && new Map<FilterGrammar, Set<string>>()
				// SAFETY: layout preflight precedes Zod's value traversal.
				if (!withinFilterBudget(payload.value as FilterTree, grammar, used)) {
					payload.issues.push({
						code: 'custom',
						input: payload.value,
						message: 'Unsupported filter layout or depth/node budget exceeded',
					})
					return payload
				}
				// Validate against the relations this input names; the rest are absent.
				return used ? resolve(used)._zod.run(payload, ctx) : parse(payload, ctx)
			}
		},
	)
	return new BoundedFilterObject(definition)
}

class UnsupportedFilterCapture extends Error {}

// Copy the generated schema graph before exposing the public filter. These are
// generated scalar predicates, not arbitrary storage schemas or consumer hooks.
function captureGrammar(
	source: FilterGrammar,
	seen = new WeakMap<FilterGrammar, FilterGrammar>(),
): FilterGrammar {
	const cached = seen.get(source)
	if (cached) return cached
	const schemas = new WeakMap<z.ZodType, z.ZodType>()
	function copy(schema: z.core.$ZodType): z.ZodType {
		if (!(schema instanceof z.ZodType)) throw new Error('Expected generated classic filter schema')
		const cached = schemas.get(schema)
		if (cached) return cached
		let result: z.ZodType
		if (schema instanceof z.ZodObject)
			result = schema.clone({
				...schema._zod.def,
				// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Installed Zod object definition property.
				shape: Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, copy(v)])),
				catchall: schema._zod.def.catchall ? copy(schema._zod.def.catchall) : undefined,
			})
		else if (schema instanceof z.ZodUnion)
			result = schema.clone({ ...schema._zod.def, options: schema.options.map(copy) })
		else if (schema instanceof z.ZodArray)
			result = schema.clone({ ...schema._zod.def, element: copy(schema.element) })
		else if (schema instanceof z.ZodOptional)
			result = schema.clone({ ...schema._zod.def, innerType: copy(schema._zod.def.innerType) })
		else if (schema instanceof z.ZodNonOptional)
			result = schema.clone({ ...schema._zod.def, innerType: copy(schema._zod.def.innerType) })
		else if (schema instanceof z.ZodNullable)
			result = schema.clone({ ...schema._zod.def, innerType: copy(schema._zod.def.innerType) })
		else if (schema instanceof z.ZodEnum)
			result = schema.clone({ ...schema._zod.def, entries: { ...schema._zod.def.entries } })
		else if (schema instanceof z.ZodLiteral)
			result = schema.clone({ ...schema._zod.def, values: [...schema._zod.def.values] })
		else if (
			schema instanceof z.ZodString ||
			schema instanceof z.ZodNumber ||
			schema instanceof z.ZodBigInt ||
			schema instanceof z.ZodBoolean ||
			schema instanceof z.ZodNull ||
			schema instanceof z.ZodNever ||
			schema instanceof z.ZodCustom
		)
			result = z.core.clone(schema, { ...schema._zod.def }, { parent: true })
		else throw new UnsupportedFilterCapture()
		// Generated membership limits and nonempty-operator refinements must not
		// share mutable check definitions with the public graph.
		if (schema._zod.def.checks) {
			const checks = schema._zod.def.checks.map((check) => {
				if (check instanceof z.ZodCustom) {
					const copied = copy(check)
					if (!(copied instanceof z.ZodCustom)) throw new UnsupportedFilterCapture()
					return copied
				}
				if (check instanceof z.core.$ZodCheckMaxLength)
					return new z.core.$ZodCheckMaxLength({ ...check._zod.def })
				if (check instanceof z.core.$ZodCheckMinLength)
					return new z.core.$ZodCheckMinLength({ ...check._zod.def })
				throw new UnsupportedFilterCapture()
			})
			result = result.clone({ ...result._zod.def, checks })
		}
		schemas.set(schema, result)
		return result
	}
	const result: FilterGrammar = {
		fields: Object.freeze(
			Object.fromEntries(Object.entries(source.fields).map(([k, v]) => [k, copy(v)])),
		),
		relations: {},
	}
	seen.set(source, result)
	result.relations = Object.freeze(
		Object.fromEntries(
			Object.entries(source.relations).map(([k, v]) => [
				k,
				Object.freeze({ cardinality: v.cardinality, target: captureGrammar(v.target, seen) }),
			]),
		),
	)
	if (source.variants)
		result.variants = Object.freeze({
			discriminator: source.variants.discriminator,
			options: Object.freeze(
				Object.fromEntries(
					Object.entries(source.variants.options).map(([k, v]) => [k, captureGrammar(v, seen)]),
				),
			),
		})
	return Object.freeze(result)
}
