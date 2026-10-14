import { convexToZod, type ConvexValidatorFromZod } from 'convex-helpers/server/zod4'
import { paginationOptsValidator } from 'convex/server'
import { compareValues, type GenericId, type GenericValidator } from 'convex/values'
import { z } from 'zod'

/** Shared hard ceilings; the execution engine may impose lower budgets. */
export const MAX_PAGE_SIZE = 100
export const MAX_FILTER_DEPTH = 4
export const MAX_FILTER_NODES = 256
export const MAX_FILTER_IN_VALUES = 100

export type FieldSchemas = Record<string, z.ZodType>
type NativeField<Schema extends z.ZodType> = ConvexValidatorFromZod<Schema, 'required'>
type ScalarKind = 'id' | 'string' | 'float64' | 'int64' | 'boolean' | 'null' | 'literal'
type SupportedNative<Validator extends GenericValidator> = Validator extends { kind: ScalarKind }
	? true
	: Validator extends { kind: 'union'; members: infer Members extends GenericValidator[] }
		? false extends SupportedNative<Members[number]>
			? false
			: true
		: false

export type ScalarSelection<Fields extends FieldSchemas> = {
	[
		Key in keyof Fields as false extends SupportedNative<NativeField<Fields[Key]>> ? never : Key
	]?: true
}
export type ExactScalarSelection<Fields extends FieldSchemas, Selection> = Selection & {
	[Key in keyof Selection]: Key extends keyof ScalarSelection<Fields>
		? Selection[Key] extends true
			? true
			: never
		: never
}

type NativeValue<Schema extends z.ZodType> = Exclude<NativeField<Schema>['type'], undefined>
type FilterInputValue<Value> = Value extends GenericId<string> ? string : Value
type FilterValue<Schema extends z.ZodType, Side extends 'input' | 'output'> = Side extends 'input'
	? FilterInputValue<NativeValue<Schema>>
	: NativeValue<Schema>
type RangeKind = 'string' | 'float64' | 'int64' | 'literal'
type OrderedNative<Validator extends GenericValidator> = Validator extends { kind: RangeKind }
	? Validator['type'] extends string | number | bigint | undefined
		? true
		: false
	: Validator extends { kind: 'union'; members: infer Members extends GenericValidator[] }
		? false extends OrderedNative<Members[number]>
			? false
			: true
		: false
type OrderedValue<Schema extends z.ZodType> =
	OrderedNative<NativeField<Schema>> extends true ? NativeValue<Schema> : never

export type ScalarPredicate<Schema extends z.ZodType, Side extends 'input' | 'output'> =
	| FilterValue<Schema, Side>
	| ({ eq?: FilterValue<Schema, Side>; in?: FilterValue<Schema, Side>[] } & ([
			OrderedValue<Schema>,
	  ] extends [never]
			? {}
			: {
					gt?: OrderedValue<Schema>
					gte?: OrderedValue<Schema>
					lt?: OrderedValue<Schema>
					lte?: OrderedValue<Schema>
				}) &
			('optional' extends NativeField<Schema>['isOptional'] ? { exists?: boolean } : {}))

type SelectedFieldFilters<
	Fields extends FieldSchemas,
	Selection,
	Side extends 'input' | 'output',
> = {
	[Key in Extract<keyof Selection, keyof Fields>]?: ScalarPredicate<Fields[Key], Side>
}

/** Direct shorthand and explicit fields combine with AND. The fields namespace
 * accepts every selected scalar name, including boolean-control/namespace names.
 */
type FilterDepth = readonly [1, 1, 1, 1]
type Tail<Depth extends readonly 1[]> = Depth extends readonly [1, ...infer Rest extends 1[]]
	? Rest
	: []

export type ScalarFilters<
	Fields extends FieldSchemas,
	Selection,
	Side extends 'input' | 'output' = 'output',
	Depth extends readonly 1[] = FilterDepth,
> = Omit<SelectedFieldFilters<Fields, Selection, Side>, 'and' | 'or' | 'not' | 'fields'> & {
	fields?: SelectedFieldFilters<Fields, Selection, Side>
} & (Depth extends readonly []
		? {}
		: {
				and?: ScalarFilters<Fields, Selection, Side, Tail<Depth>>[]
				or?: ScalarFilters<Fields, Selection, Side, Tail<Depth>>[]
				not?: ScalarFilters<Fields, Selection, Side, Tail<Depth>>
			})

const nativeOptions = convexToZod(paginationOptsValidator)
export const nativePagination = nativeOptions.strict().extend({
	numItems: nativeOptions.shape.numItems.int().positive().max(MAX_PAGE_SIZE),
	maximumRowsRead: nativeOptions.shape.maximumRowsRead.unwrap().int().positive().optional(),
	maximumBytesRead: nativeOptions.shape.maximumBytesRead.unwrap().int().positive().optional(),
})
export type NativePagination = z.output<typeof nativePagination>
/** Preserve the object boundary so pagination options can be registered directly as query args. */
export type PaginationOptionsSchema<Filters, InputFilters = Filters> = z.ZodObject<
	(typeof nativePagination)['shape'] & {
		filters: z.ZodOptional<z.ZodType<Filters, InputFilters>>
		order: z.ZodOptional<z.ZodEnum<{ asc: 'asc'; desc: 'desc' }>>
	},
	z.core.$strict
>
export type ScalarPaginationSchema<
	Fields extends FieldSchemas,
	Selection,
> = PaginationOptionsSchema<
	ScalarFilters<Fields, Selection>,
	ScalarFilters<Fields, Selection, 'input'>
>

/** Scalar-only schema constructor shared by table and future registry boundaries.
 * Convex metadata describes stored INPUT, so storage refinements/transforms never run here.
 */
export function scalarPaginationSchema<
	Fields extends FieldSchemas,
	const Selection extends ScalarSelection<Fields>,
>(
	validators: Record<string, GenericValidator>,
	selection: ExactScalarSelection<Fields, Selection>,
): ScalarPaginationSchema<Fields, Selection> {
	const predicates: FieldSchemas = {}
	for (const [key, selected] of Object.entries(selection)) {
		if (selected !== true || !Object.hasOwn(validators, key)) {
			throw new Error(`Invalid scalar filter selection "${key}"`)
		}
		predicates[key] = scalarPredicateSchema(validators[key]).optional()
	}
	const filters = boundedFilterSchema(predicates)
	const result = nativePagination.extend({
		filters: filters.optional(),
		order: z.enum(['asc', 'desc']).optional(),
	})
	// SAFETY: selected validators generate the same native scalar input/output relationships
	// described by ScalarFilters, including converter-registered ID brands.
	return result as ScalarPaginationSchema<Fields, Selection>
}

export function scalarPredicateSchema(validator: GenericValidator): z.ZodType {
	assertSupportedScalar(validator)
	const scalar = convexToZod(validator).nonoptional()
	const equality = z.object({
		eq: scalar.optional(),
		in: z.array(scalar).min(1).max(MAX_FILTER_IN_VALUES).optional(),
	})
	const ranged = supportsRange(validator)
		? equality.extend({
				gt: scalar.optional(),
				gte: scalar.optional(),
				lt: scalar.optional(),
				lte: scalar.optional(),
			})
		: equality
	const existence =
		validator.isOptional === 'optional' ? ranged.extend({ exists: z.boolean().optional() }) : ranged
	const explicit = existence
		.strict()
		.refine(
			(value) => Object.values(value).some((entry) => entry !== undefined),
			'At least one operator is required',
		)
	return z.union([scalar, explicit])
}

type FilterTree =
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

const BoundedFilterObject = z.core.$constructor<z.ZodObject>('BoundedFilterObject', (inst, def) => {
	z.ZodObject.init(inst, def)
	const parse = inst._zod.parse
	const namespace = def.shape.fields
	const namespaceObject = namespace instanceof z.ZodOptional ? namespace.unwrap() : undefined
	const selectedKeys =
		namespaceObject instanceof z.ZodObject
			? Object.keys(namespaceObject.shape)
			: Object.keys(def.shape)
	const grammar: FilterGrammar = {
		variants: variantPredicates.get(def.shape.variant),
		fields: Object.fromEntries(selectedKeys.map((key) => [key, def.shape[key]])),
		relations: Object.fromEntries(
			Object.entries(def.shape).flatMap(([key, schema]) => {
				const relation = relationPredicates.get(schema)
				return relation ? [[key, relation]] : []
			}),
		),
	}
	// Zod refinements run after parsing. Guard parse itself so both the deferred
	// no-check run and the refinement run retain the same pre-child boundary.
	inst._zod.parse = (payload, ctx) => {
		// SAFETY: preflight examines layout and budgets only; Zod still validates values.
		if (!withinFilterBudget(payload.value as FilterTree, grammar)) {
			payload.issues.push({
				code: 'custom',
				input: payload.value,
				message: 'Unsupported filter layout or depth/node budget exceeded',
			})
			return payload
		}
		return parse(payload, ctx)
	}
})

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
): z.ZodType {
	const schema = new BoundedFilterObject(filterNodeSchema(grammar, 0, cache)._zod.def)
	filterGrammars.set(schema, grammar)
	return schema
}

export type FilterScalar = string | number | bigint | boolean | null
export type FilterOperator = 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'
export type FilterAst =
	| { kind: 'and' | 'or'; children: FilterAst[] }
	| { kind: 'not'; child: FilterAst }
	| { kind: 'variant'; discriminator: string; tag: string; child: FilterAst }
	| {
			kind: 'scalar'
			field: string
			operator: FilterOperator
			value: FilterScalar | FilterScalar[]
	  }
	| { kind: 'relation'; name: string; mode: 'one' | 'some' | 'none'; predicate: FilterAst | null }
export interface QueryIndex {
	name: string
	fields: readonly string[]
}
export interface IndexCondition {
	value: FilterScalar | undefined
	index: string
}
export interface CompiledFilters {
	residual: FilterAst
	bindings: ReadonlyMap<string, FilterScalar>
	unsatisfiable: boolean
	index: QueryIndex | null
	prefix: readonly { field: string; value: FilterScalar }[]
}
type FilterSpec<Schema extends z.ZodType> =
	z.input<Schema> extends { filters?: infer Spec } ? Spec : never
export type ServerFilter<Fields extends FieldSchemas> = ScalarFilters<
	Fields,
	ScalarSelection<Fields>
>

interface BindingResult {
	values: Map<string, FilterScalar>
	impossible: boolean
}

/** Validate first; where is independently validated and ANDed with client predicates.
 * OR remains a residual expression over one traversal, never multiple streams.
 */
export function compileFilters<Schema extends z.ZodType>(
	schema: Schema,
	input: z.input<Schema>,
	indexes: readonly QueryIndex[],
	conditions: readonly IndexCondition[] = [],
	where?: FilterSpec<Schema>,
): CompiledFilters {
	// SAFETY: pagination schemas validate filters before this internal AST adapter reads them.
	const parsed = schema.parse(input) as { filters?: FilterTree }
	// SAFETY: server filters use the same validation boundary as client filters.
	const server =
		where === undefined
			? undefined
			: (schema.parse({ ...parsed, filters: where }) as { filters?: FilterTree })
	const grammar = paginationGrammar(schema)
	const residual: FilterAst = {
		kind: 'and',
		children: [
			normalizeFilters(parsed.filters, grammar),
			normalizeFilters(server?.filters, grammar),
		],
	}
	const guaranteed = guaranteedBindings(residual)
	const sorted = [...indexes].sort(
		(a, b) =>
			a.name.localeCompare(b.name) || a.fields.join('\0').localeCompare(b.fields.join('\0')),
	)
	const condition = conditions.find((entry) => entry.value !== null && entry.value !== undefined)
	let index: QueryIndex | null = null
	if (condition) {
		index = sorted.find((entry) => entry.name === condition.index) ?? null
		if (!index || prefixBindings(index, guaranteed.values).length === 0)
			throw new Error(`Explicit index "${condition.index}" is incompatible with guaranteed filters`)
	} else {
		let length = 0
		for (const candidate of sorted) {
			const usable = prefixBindings(candidate, guaranteed.values).length
			if (usable > length) {
				index = candidate
				length = usable
			}
		}
	}
	return {
		residual,
		bindings: guaranteed.values,
		unsatisfiable: guaranteed.impossible,
		index,
		prefix: index ? prefixBindings(index, guaranteed.values) : [],
	}
}
function paginationGrammar(schema: z.ZodType): FilterGrammar | undefined {
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
function normalizeFilters(value: FilterTree, grammar?: FilterGrammar): FilterAst {
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
function valueEqual(left: FilterScalar, right: FilterScalar): boolean {
	return compareValues(left, right) === 0
}
function guaranteedBindings(ast: FilterAst): BindingResult {
	const values = new Map<string, FilterScalar>()
	if (ast.kind === 'variant')
		return guaranteedBindings({
			kind: 'and',
			children: [
				{ kind: 'scalar', field: ast.discriminator, operator: 'eq', value: ast.tag },
				ast.child,
			],
		})
	if (ast.kind === 'scalar') {
		if (ast.operator === 'eq' && !Array.isArray(ast.value)) values.set(ast.field, ast.value)
		const choices = Array.isArray(ast.value) ? ast.value : undefined
		if (ast.operator === 'in' && choices && choices.every((value) => valueEqual(value, choices[0])))
			values.set(ast.field, choices[0])
		return { values, impossible: false }
	}
	if (ast.kind === 'not' || ast.kind === 'relation') return { values, impossible: false }
	const branches = ast.children.map(guaranteedBindings)
	if (ast.kind === 'or') {
		const viable = branches.filter((branch) => !branch.impossible)
		for (const [field, value] of viable[0]?.values ?? [])
			if (
				viable.every(
					(branch) => branch.values.has(field) && valueEqual(branch.values.get(field)!, value),
				)
			)
				values.set(field, value)
		return { values, impossible: viable.every((branch) => branch.impossible) }
	}
	let impossible = branches.some((branch) => branch.impossible)
	for (const branch of branches)
		for (const [field, value] of branch.values) {
			if (values.has(field) && !valueEqual(values.get(field)!, value)) impossible = true
			values.set(field, value)
		}
	return { values, impossible }
}
function prefixBindings(
	index: QueryIndex,
	bindings: ReadonlyMap<string, FilterScalar>,
): { field: string; value: FilterScalar }[] {
	const prefix: { field: string; value: FilterScalar }[] = []
	for (const field of index.fields) {
		if (!bindings.has(field)) break
		prefix.push({ field, value: bindings.get(field)! })
	}
	return prefix
}

function assertSupportedScalar(validator: GenericValidator): void {
	switch (validator.kind) {
		case 'id':
		case 'string':
		case 'float64':
		case 'int64':
		case 'boolean':
		case 'null':
		case 'literal':
			return
		case 'union':
			for (const member of validator.members) {
				assertSupportedScalar(member)
			}
			return
		default:
			throw new Error(`Unsupported scalar filter kind "${validator.kind}"`)
	}
}

function supportsRange(validator: GenericValidator): boolean {
	switch (validator.kind) {
		case 'string':
		case 'float64':
		case 'int64':
			return true
		case 'literal':
			return z.union([z.string(), z.number(), z.bigint()]).safeParse(validator.value).success
		case 'union':
			return validator.members.every(supportsRange)
		default:
			return false
	}
}

function boundedFilterSchema(predicates: FieldSchemas): z.ZodType {
	return relationFilterSchema({ fields: predicates, relations: {} })
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

function withinFilterBudget(value: FilterTree, grammar: FilterGrammar): boolean {
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
				} else if (entry.grammar.relations[name]) {
					const relation = entry.grammar.relations[name]
					context = relation.cardinality === 'one' ? 'expression' : 'many'
					target = relation.target
					depth++
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
