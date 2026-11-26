// v1 bridge (U23 -> U18): the frozen Zod pagination and filter schemas of src/querying/filters.ts and
// src/querying/shared/page.ts, moved verbatim so the v1 Zod files keep working while the engine layer
// is on `k`. Planning itself is the v2 module's own. Only v1 files import it; the cutover deletes it.
import {
	boundedFilterSchema,
	paginationGrammar,
	scalarPredicateFromSchema,
	type FilterTree,
	type FieldSchemas,
} from './v1-zod-shared-filters'
import type { PaginationValidatorOptions } from './shared/filters'
// oxlint-disable-next-line cvx/no-internal-reexports -- v1 bridge: existing v1 imports keep one boundary until the cutover.
export {
	relationFilterSchema,
	lazyRelationFilterSchema,
	MAX_FILTER_DEPTH,
	MAX_FILTER_NODES,
	MAX_FILTER_IN_VALUES,
	type FilterGrammar,
	type FieldSchemas,
} from './v1-zod-shared-filters'
import {
	MAX_PAGE_SIZE,
	planParsedFilters,
	type CompiledFilters,
	type IndexCondition,
	type QueryIndex,
} from './filters'
import { convexToZod, type ConvexValidatorFromZod } from 'convex-helpers/server/zod4'
import { paginationOptsValidator } from 'convex/server'
import type { GenericId, GenericValidator } from 'convex/values'
import { z } from 'zod'

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
	/** Explicitly accept safe progressing empty splits; legacy safe splits remain supported. */
	onEmptyBudget: z.literal('split').optional(),
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
	options?: PaginationValidatorOptions,
): ScalarPaginationSchema<Fields, Selection> {
	const predicates: FieldSchemas = {}
	for (const [key, selected] of Object.entries(selection)) {
		if (selected !== true || !Object.hasOwn(validators, key)) {
			throw new Error(`Invalid scalar filter selection "${key}"`)
		}
		predicates[key] = scalarPredicateSchema(validators[key]).optional()
	}
	const filters = boundedFilterSchema(predicates, options)
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
	return scalarPredicateFromSchema(
		scalar,
		supportsRange(validator),
		validator.isOptional === 'optional',
	)
}

type FilterSpec<Schema extends z.ZodType> =
	z.input<Schema> extends { filters?: infer Spec } ? Spec : never
export type ServerFilter<Fields extends FieldSchemas> = ScalarFilters<
	Fields,
	ScalarSelection<Fields>
>

/** Validate first; where is independently validated and ANDed with client predicates.
 * Only guaranteed sets at one consecutive index position may expand.
 */
export function compileFilters<Schema extends z.ZodType>(
	schema: Schema,
	input: z.input<Schema>,
	indexes: readonly QueryIndex[],
	conditions: readonly IndexCondition[] = [],
	where?: FilterSpec<Schema>,
): CompiledFilters {
	return parseFilterPlan(schema, input, indexes, conditions, where).compiled
}

/** Internal planner boundary: retain the parsed arguments without parsing them again. */
export function parseFilterPlan<Schema extends z.ZodType>(
	schema: Schema,
	input: z.input<Schema>,
	indexes: readonly QueryIndex[],
	conditions: readonly IndexCondition[] = [],
	where?: FilterSpec<Schema>,
	ordering?: string,
) {
	const args = schema.parse(input)
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

/** Construct only the result boundary when native pagination arguments are unused. */
export function pageResult<Dto extends z.ZodType>(dto: Dto) {
	return z.object({
		page: z.array(dto),
		paginationMode: z.literal('native-search').optional(),
		isDone: z.boolean(),
		continueCursor: z.string(),
		splitCursor: z.string().nullable().optional(),
		pageStatus: z.enum(['SplitRecommended', 'SplitRequired']).nullable().optional(),
		completeness: z
			.enum(['complete', 'row-budget', 'byte-budget', 'native-limit', 'result-cap'])
			.optional(),
	})
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
