import {
	boundedFilterSchema,
	paginationGrammar,
	normalizeFilters,
	scalarPredicateFromSchema,
	unionOf,
	type FilterGrammarOf,
	type FilterTree,
	type FieldSchemas,
	type KFilterSchema,
	type PaginationValidatorOptions,
} from './shared/filters'
// oxlint-disable-next-line cvx/no-internal-reexports -- Preserve existing internal imports while the neutral grammar owns implementation.
export {
	relationFilterSchema,
	MAX_FILTER_DEPTH,
	MAX_FILTER_NODES,
	MAX_FILTER_IN_VALUES,
	type FilterGrammar,
	type FieldSchemas,
	type KFilterSchema,
} from './shared/filters'
import { valueEqual, type FilterAst, type FilterScalar } from './shared/ast'
// oxlint-disable-next-line cvx/no-internal-reexports -- Existing executor consumers retain their type import boundary.
export type { FilterAst, FilterScalar, FilterOperator } from './shared/ast'
import { paginationOptsValidator } from 'convex/server'
import { compareValues, type GenericId, type GenericValidator } from 'convex/values'
import {
	k,
	type KEnum,
	type KLiteral,
	type KNullable,
	type KNumber,
	type KObject,
	type KOptional,
	type KSchema,
	type KString,
	type KType,
} from '../k'

/** Shared hard ceilings; the execution engine may impose lower budgets. */
export const MAX_PAGE_SIZE = 100

type NativeField<Schema extends KType> = Schema['validator']
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

type NativeValue<Schema extends KType> = Exclude<NativeField<Schema>['type'], undefined>
type FilterInputValue<Value> = Value extends GenericId<string> ? string : Value
type FilterValue<Schema extends KType, Side extends 'input' | 'output'> = Side extends 'input'
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
type OrderedValue<Schema extends KType> =
	OrderedNative<NativeField<Schema>> extends true ? NativeValue<Schema> : never

export type ScalarPredicate<Schema extends KType, Side extends 'input' | 'output'> =
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

/** The fields of the engine's pagination options: Convex's, bounded, plus `onEmptyBudget`. */
export type NativePaginationFields = {
	readonly numItems: KNumber
	readonly cursor: KNullable<KString>
	readonly endCursor: KOptional<KNullable<KString>>
	readonly id: KOptional<KNumber>
	readonly maximumRowsRead: KOptional<KNumber>
	readonly maximumBytesRead: KOptional<KNumber>
	/** Explicitly accept safe progressing empty splits; legacy safe splits remain supported. */
	readonly onEmptyBudget: KOptional<KLiteral<'split'>>
}
export type NativePaginationSchema = KObject<NativePaginationFields>
export type NativePagination = {
	numItems: number
	cursor: string | null
	endCursor?: string | null
	id?: number
	maximumRowsRead?: number
	maximumBytesRead?: number
	onEmptyBudget?: 'split'
}

/**
 * The engine's pagination options, built on first request and then shared: nothing is declared at
 * import (R22). Numbers are finite as v1's Zod conversion required; the native validator is Convex's
 * `paginationOptsValidator` plus `onEmptyBudget`.
 */
export function nativePagination(): NativePaginationSchema {
	return (nativeOptions ??= k.object({
		numItems: finiteNumber().int().refine(positive, POSITIVE).max(MAX_PAGE_SIZE),
		cursor: k.string().nullable(),
		endCursor: k.string().nullable().optional(),
		id: finiteNumber().optional(),
		maximumRowsRead: finiteNumber().int().refine(positive, POSITIVE).optional(),
		maximumBytesRead: finiteNumber().int().refine(positive, POSITIVE).optional(),
		onEmptyBudget: k.literal('split').optional(),
	}))
}

/** Convex's own `paginationOptsValidator` as a `k` object, for `paginated(dto).args`. Unknown keys strip, as v1's did. */
export function convexPaginationOptions(): KObject<Omit<NativePaginationFields, 'onEmptyBudget'>> {
	if (convexOptions) return convexOptions
	const native = paginationOptsValidator.fields
	const fields = {
		numItems: finiteNumber(),
		cursor: k.string().nullable(),
		endCursor: k.string().nullable().optional(),
		id: finiteNumber().optional(),
		maximumRowsRead: finiteNumber().optional(),
		maximumBytesRead: finiteNumber().optional(),
	}
	for (const key of Object.keys(native))
		if (!Object.hasOwn(fields, key)) throw new Error(`Unsupported Convex pagination field "${key}"`)
	return (convexOptions = k.object(fields).strip())
}

/** Preserve the object boundary so pagination options can be registered directly as query args. */
export type PaginationOptionsSchema<Filters> = KObject<
	NativePaginationFields & {
		readonly filters: KOptional<KFilterSchema<Filters>>
		readonly order: KOptional<KEnum<readonly ['asc', 'desc']>>
	}
>
export type ScalarPaginationSchema<
	Fields extends FieldSchemas,
	Selection,
> = PaginationOptionsSchema<ScalarFilters<Fields, Selection>>

/** Scalar-only schema constructor shared by table and future registry boundaries.
 * Convex metadata describes stored INPUT, so storage refinements/transforms never run here.
 */
export function scalarPaginationSchema<
	Fields extends FieldSchemas,
	const Selection extends ScalarSelection<Fields>,
>(
	validators: Record<string, GenericValidator>,
	selection: ExactScalarSelection<Fields, Selection>,
	options?: PaginationValidatorOptions,
): ScalarPaginationSchema<Fields, Selection> {
	// SAFETY: selected validators generate the same native scalar input/output relationships
	// described by ScalarFilters, including native ID tables.
	return paginationSchemaOf(validators, selection, options) as ScalarPaginationSchema<
		Fields,
		Selection
	>
}

/** The untyped constructor behind `scalarPaginationSchema`, for boundaries that type it themselves. */
export function paginationSchemaOf(
	validators: Record<string, GenericValidator>,
	selection: Readonly<Record<string, boolean>>,
	options?: PaginationValidatorOptions,
): KObject<any> {
	const predicates: FieldSchemas = {}
	for (const [key, selected] of Object.entries(selection)) {
		if (selected !== true || !Object.hasOwn(validators, key)) {
			throw new Error(`Invalid scalar filter selection "${key}"`)
		}
		predicates[key] = schemaOf(scalarPredicateSchema(validators[key])).optional()
	}
	const filters = boundedFilterSchema(predicates, options)
	return nativePagination().extend({
		filters: filters.optional(),
		order: k.enum(['asc', 'desc']).optional(),
	})
}

export function scalarPredicateSchema(validator: GenericValidator): KType {
	assertSupportedScalar(validator)
	return scalarPredicateFromSchema(
		scalarFromNative(validator),
		supportsRange(validator),
		validator.isOptional === 'optional',
	)
}

export interface QueryIndex {
	name: string
	fields: readonly string[]
}
export interface IndexCondition {
	value: FilterScalar | undefined
	index: string
}
export interface RangeBound {
	value: FilterScalar
	inclusive: boolean
}
export interface FieldRange {
	lower?: RangeBound
	upper?: RangeBound
}
export interface NativeRange extends FieldRange {
	field: string
}
export const MAX_INDEX_EXPANSION = 8
export interface IndexExpansion {
	field: string
	values: FilterScalar[]
	comparator: 'tail' | 'full-index'
}
export interface CompiledFilters {
	expansion: IndexExpansion | null
	sets: ReadonlyMap<string, FilterScalar[]>

	residual: FilterAst
	bindings: ReadonlyMap<string, FilterScalar>
	ranges: ReadonlyMap<string, FieldRange>
	range: NativeRange | null
	unsatisfiable: boolean
	index: QueryIndex | null
	prefix: readonly { field: string; value: FilterScalar }[]
}
type FilterSpec<Schema extends KSchema<any, any, any, any, any>> = Schema['_input'] extends {
	filters?: infer Spec
}
	? Spec
	: never
export type ServerFilter<Fields extends FieldSchemas> = ScalarFilters<
	Fields,
	ScalarSelection<Fields>
>

interface BindingResult {
	values: Map<string, FilterScalar>
	impossible: boolean
}

/** Validate first; where is independently validated and ANDed with client predicates.
 * Only guaranteed sets at one consecutive index position may expand.
 */
export function compileFilters<Schema extends KSchema<any, any, any, any, any>>(
	schema: Schema,
	input: Schema['_input'],
	indexes: readonly QueryIndex[],
	conditions: readonly IndexCondition[] = [],
	where?: FilterSpec<Schema>,
): CompiledFilters {
	return parseFilterPlan(schema, input, indexes, conditions, where).compiled
}

/**
 * Internal planner boundary: retain the parsed arguments without parsing them again. Both the
 * client and the server filters run the full walker, so a failure is a `KValidationError` (KTD6).
 */
export function parseFilterPlan<Schema extends KSchema<any, any, any, any, any>>(
	schema: Schema,
	input: Schema['_input'],
	indexes: readonly QueryIndex[],
	conditions: readonly IndexCondition[] = [],
	where?: FilterSpec<Schema>,
	ordering?: string,
) {
	const args: Schema['_output'] = schema.parse(input)
	// SAFETY: pagination schemas validate filters before this internal AST adapter reads them.
	const parsed = args as { filters?: FilterTree }
	// SAFETY: server filters use the same validation boundary as client filters.
	const server =
		where === undefined
			? undefined
			: (schema.parse({ ...parsed, filters: where }) as { filters?: FilterTree })
	const compiled = planParsedFilters({
		client: parsed.filters,
		server: server?.filters,
		grammar: paginationGrammar(schema),
		indexes,
		conditions,
		ordering,
	})
	return { args, compiled }
}

/** The filters of one already parsed request and the indexes the planner may choose from. */
export interface ParsedFilterRequest {
	readonly client: FilterTree
	readonly server: FilterTree
	readonly grammar: FilterGrammarOf<unknown> | undefined
	readonly indexes: readonly QueryIndex[]
	readonly conditions: readonly IndexCondition[]
	readonly ordering: string | undefined
}

/**
 * Plan already validated filters: index choice, bindings, ranges and expansion, raising the
 * transportable fan-out error.
 */
export function planParsedFilters(request: ParsedFilterRequest): CompiledFilters {
	const { grammar, indexes, conditions, ordering } = request
	const residual: FilterAst = {
		kind: 'and',
		children: [
			canonicalSets(normalizeFilters(request.client, grammar)),
			canonicalSets(normalizeFilters(request.server, grammar)),
		],
	}
	const guaranteed = guaranteedBindings(residual)
	const ranges = guaranteedRanges(residual)
	const sets = guaranteedSets(residual)
	for (const [field, values] of sets) {
		const eligible = values.filter(
			(value) =>
				(!guaranteed.values.has(field) || valueEqual(value, guaranteed.values.get(field)!)) &&
				(!ranges.has(field) || withinRange(value, ranges.get(field)!)),
		)
		sets.set(field, eligible)
		if (!eligible.length) guaranteed.impossible = true
	}
	for (const [field, range] of ranges) {
		if (range.lower && range.upper) {
			const compared = compareValues(range.lower.value, range.upper.value)
			if (compared > 0 || (compared === 0 && (!range.lower.inclusive || !range.upper.inclusive)))
				guaranteed.impossible = true
		}
		if (guaranteed.values.has(field) && !withinRange(guaranteed.values.get(field)!, range))
			guaranteed.impossible = true
	}
	const sorted = [...indexes].sort(
		(a, b) =>
			a.name.localeCompare(b.name) || a.fields.join('\0').localeCompare(b.fields.join('\0')),
	)
	const condition = conditions.find((entry) => entry.value !== null && entry.value !== undefined)
	let index: QueryIndex | null = null
	if (ordering !== undefined) {
		if (condition) throw new Error('orderBy cannot be combined with an active when selector')
		index = sorted.find((entry) => entry.name === ordering) ?? null
		if (!index) throw new Error(`Unknown ordering index "${ordering}"`)
	} else if (condition) {
		index = sorted.find((entry) => entry.name === condition.index) ?? null
		if (!index || prefixBindings(index, guaranteed.values).length === 0)
			throw new Error(`Explicit index "${condition.index}" is incompatible with guaranteed filters`)
	} else {
		let length = 0
		let ranged = false
		for (const candidate of sorted) {
			const prefix = prefixBindings(candidate, guaranteed.values)
			const expanded = sets.has(candidate.fields[prefix.length])
			const usable = prefix.length + Number(expanded)
			const hasRange = ranges.has(candidate.fields[usable])
			if (usable > length || (usable === length && hasRange && !ranged)) {
				index = candidate
				length = usable
				ranged = hasRange
			}
		}
	}
	const prefix = index ? prefixBindings(index, guaranteed.values) : []
	const expansion =
		index && !guaranteed.impossible
			? expansionForIndex(index, prefix, sets, ordering !== undefined || !!condition)
			: null
	return {
		sets,
		expansion,
		residual,
		bindings: guaranteed.values,
		ranges,
		range: index ? rangeForIndex(index, prefixBindings(index, guaranteed.values), ranges) : null,
		unsatisfiable: guaranteed.impossible,
		index,
		prefix: index ? prefixBindings(index, guaranteed.values) : [],
	}
}
export function withinRange(value: FilterScalar, range: FieldRange): boolean {
	const lower = range.lower && compareValues(value, range.lower.value)
	const upper = range.upper && compareValues(value, range.upper.value)
	return (
		(lower === undefined || lower > 0 || (lower === 0 && range.lower!.inclusive)) &&
		(upper === undefined || upper < 0 || (upper === 0 && range.upper!.inclusive))
	)
}
/** Recompute against the actual stream prefix, including relationship lookup bindings. */
export function rangeForIndex(
	index: QueryIndex,
	prefix: readonly { field: string; value: FilterScalar }[],
	ranges: ReadonlyMap<string, FieldRange>,
): NativeRange | null {
	const field = index.fields[prefix.length]
	const range = ranges.get(field)
	return range ? { field, ...range } : null
}
/** Recompute for the actual lookup prefix on direct relationships, too. */
export function expansionForIndex(
	index: QueryIndex,
	prefix: readonly { field: string; value: FilterScalar }[],
	sets: ReadonlyMap<string, FilterScalar[]>,
	explicit: boolean,
): IndexExpansion | null {
	const field = index.fields[prefix.length]
	const values = sets.get(field)
	if (!values?.length) return null
	if (values.length > MAX_INDEX_EXPANSION) {
		if (explicit) return null
		const error = new Error('QUERY_FANOUT')
		queryFanoutErrors.add(error)
		throw error
	}
	return { field, values, comparator: explicit ? 'full-index' : 'tail' }
}

// Preserve the existing Error/message for direct callers; only engine-created identities are transportable.
const queryFanoutErrors = new WeakSet<Error>()
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Endpoint projection must accept arbitrary thrown values.
export function isQueryFanoutError(error: unknown): boolean {
	return error instanceof Error && queryFanoutErrors.has(error)
}

/** Normalize only membership sets; unrelated boolean expressions retain their identity. */
function canonicalSets(ast: FilterAst): FilterAst {
	if (ast.kind === 'scalar' && ast.operator === 'in' && Array.isArray(ast.value))
		return { ...ast, value: uniqueValues(ast.value) }
	if (ast.kind === 'and' || ast.kind === 'or') {
		const children = ast.children.map(canonicalSets)
		const scalar = (node: FilterAst): { field: string; value: FilterScalar } | undefined => {
			if (node.kind === 'scalar' && node.operator === 'eq' && !Array.isArray(node.value))
				return { field: node.field, value: node.value }
			if (node.kind === 'and' && node.children.length === 1) return scalar(node.children[0])
			return undefined
		}
		const branches = children.map(scalar)
		const first = branches[0]
		if (ast.kind === 'or' && first && branches.every((branch) => branch?.field === first.field))
			return {
				kind: 'scalar',
				field: first.field,
				operator: 'in',
				value: uniqueValues(branches.map((branch) => branch!.value)),
			}
		return { ...ast, children }
	}
	if (ast.kind === 'not') return { ...ast, child: canonicalSets(ast.child) }
	if (ast.kind === 'variant') return { ...ast, child: canonicalSets(ast.child) }
	if (ast.kind === 'relation' && ast.predicate)
		return { ...ast, predicate: canonicalSets(ast.predicate) }
	return ast
}
function uniqueValues(values: FilterScalar[]): FilterScalar[] {
	return [...values]
		.sort(compareValues)
		.filter((value, i, sorted) => i === 0 || !valueEqual(value, sorted[i - 1]))
}
function guaranteedSets(ast: FilterAst, sets = new Map<string, FilterScalar[]>()) {
	if (ast.kind === 'and') for (const child of ast.children) guaranteedSets(child, sets)
	else if (ast.kind === 'variant') guaranteedSets(ast.child, sets)
	else if (ast.kind === 'scalar' && ast.operator === 'in' && Array.isArray(ast.value)) {
		const previous = sets.get(ast.field)
		sets.set(
			ast.field,
			previous
				? ast.value.filter((value) => previous.some((other) => valueEqual(value, other)))
				: ast.value,
		)
	}
	return sets
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
		if (
			ast.operator === 'in' &&
			choices?.length &&
			choices.every((value) => valueEqual(value, choices[0]))
		)
			values.set(ast.field, choices[0])
		return { values, impossible: ast.operator === 'in' && choices?.length === 0 }
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
/** Bounds under OR/NOT are deliberately residual, even when branches coincide. */
function guaranteedRanges(ast: FilterAst, ranges = new Map<string, FieldRange>()) {
	if (ast.kind === 'and') for (const child of ast.children) guaranteedRanges(child, ranges)
	else if (ast.kind === 'variant') guaranteedRanges(ast.child, ranges)
	else if (ast.kind === 'scalar' && !Array.isArray(ast.value)) {
		const lower = ast.operator === 'gt' || ast.operator === 'gte'
		const upper = ast.operator === 'lt' || ast.operator === 'lte'
		if (lower || upper) {
			const range = ranges.get(ast.field) ?? {}
			const side = lower ? 'lower' : 'upper'
			const next = { value: ast.value, inclusive: ast.operator === 'gte' || ast.operator === 'lte' }
			const previous = range[side]
			const compared = previous ? compareValues(next.value, previous.value) : 0
			if (!previous || (lower ? compared > 0 : compared < 0) || (compared === 0 && !next.inclusive))
				range[side] = next
			ranges.set(ast.field, range)
		}
	}
	return ranges
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
			return orderedLiteral(validator.value)
		case 'union':
			return validator.members.every(supportsRange)
		default:
			return false
	}
}

let nativeOptions: NativePaginationSchema | undefined
let convexOptions: KObject<Omit<NativePaginationFields, 'onEmptyBudget'>> | undefined

const POSITIVE = 'Too small: expected number to be >0'

function finiteNumber(): KNumber {
	return k.number().refine(Number.isFinite, 'Invalid input: expected a finite number')
}

function positive(value: number): boolean {
	return value > 0
}

/** The `k` scalar a native validator describes; numbers are finite, as v1's Zod conversion required. */
function scalarFromNative(validator: GenericValidator): KType {
	switch (validator.kind) {
		case 'id':
			return k.id(validator.tableName)
		case 'string':
			return k.string()
		case 'float64':
			return finiteNumber()
		case 'int64':
			return k.int64()
		case 'boolean':
			return k.boolean()
		case 'null':
			return k.null()
		case 'literal':
			return k.literal(validator.value)
		case 'union':
			return unionOf(validator.members.map(scalarFromNative))
		default:
			throw new Error(`Unsupported scalar filter kind "${validator.kind}"`)
	}
}

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- A native literal value is classified by representation.
function orderedLiteral(value: string | number | bigint | boolean): boolean {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Booleans are the only literals without an order.
	return typeof value !== 'boolean'
}

function schemaOf(schema: KType): KSchema<any, any, any, any, any> {
	// SAFETY: every KType at runtime is a KSchema record created by a k factory.
	return schema as KSchema<any, any, any, any, any>
}
