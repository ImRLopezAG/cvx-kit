import { convexToZod, type ConvexValidatorFromZod } from 'convex-helpers/server/zod4'
import { paginationOptsValidator } from 'convex/server'
import type { GenericId, GenericValidator } from 'convex/values'
import { z } from 'zod'

/** Shared hard ceilings; the execution engine may impose lower budgets. */
export const MAX_PAGE_SIZE = 100
export const MAX_FILTER_DEPTH = 4
export const MAX_FILTER_NODES = 256
export const MAX_FILTER_IN_VALUES = 100

type FieldSchemas = Record<string, z.ZodType>
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

type ScalarPredicate<Schema extends z.ZodType, Side extends 'input' | 'output'> =
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
			(NativeField<Schema>['isOptional'] extends 'optional' ? { exists?: boolean } : {}))

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
export type ScalarFilters<
	Fields extends FieldSchemas,
	Selection,
	Side extends 'input' | 'output' = 'output',
> = Omit<SelectedFieldFilters<Fields, Selection, Side>, 'and' | 'or' | 'not' | 'fields'> & {
	fields?: SelectedFieldFilters<Fields, Selection, Side>
	and?: ScalarFilters<Fields, Selection, Side>[]
	or?: ScalarFilters<Fields, Selection, Side>[]
	not?: ScalarFilters<Fields, Selection, Side>
}

const nativeOptions = convexToZod(paginationOptsValidator)
const nativePagination = nativeOptions.strict().extend({
	numItems: nativeOptions.shape.numItems.int().positive().max(MAX_PAGE_SIZE),
	maximumRowsRead: nativeOptions.shape.maximumRowsRead.unwrap().int().positive().optional(),
	maximumBytesRead: nativeOptions.shape.maximumBytesRead.unwrap().int().positive().optional(),
})
type NativePagination = z.output<typeof nativePagination>
export type ScalarPaginationSchema<Fields extends FieldSchemas, Selection> = z.ZodType<
	NativePagination & { filters?: ScalarFilters<Fields, Selection>; order?: 'asc' | 'desc' },
	NativePagination & { filters?: ScalarFilters<Fields, Selection, 'input'>; order?: 'asc' | 'desc' }
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

function scalarPredicateSchema(validator: GenericValidator): z.ZodType {
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
const BoundedFilterObject = z.core.$constructor<z.ZodObject>('BoundedFilterObject', (inst, def) => {
	z.ZodObject.init(inst, def)
	const parse = inst._zod.parse
	const namespace = def.shape.fields
	const namespaceObject = namespace instanceof z.ZodOptional ? namespace.unwrap() : undefined
	const selectedKeys =
		namespaceObject instanceof z.ZodObject
			? Object.keys(namespaceObject.shape)
			: Object.keys(def.shape)
	// Zod refinements run after parsing. Guard parse itself so both the deferred
	// no-check run and the refinement run retain the same pre-child boundary.
	inst._zod.parse = (payload, ctx) => {
		// SAFETY: preflight examines layout and budgets only; Zod still validates values.
		if (!withinFilterBudget(payload.value as FilterTree, selectedKeys)) {
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

function boundedFilterSchema(predicates: FieldSchemas): z.ZodType {
	return new BoundedFilterObject(filterNodeSchema(predicates, 0)._zod.def)
}

function filterNodeSchema(predicates: FieldSchemas, depth: number): z.ZodObject {
	const direct = Object.fromEntries(
		Object.entries(predicates).filter(([key]) => !['and', 'or', 'not', 'fields'].includes(key)),
	)
	const node = z.object({ ...direct, fields: z.object(predicates).strict().optional() }).strict()
	if (depth === MAX_FILTER_DEPTH) return node
	const child = filterNodeSchema(predicates, depth + 1)
	return node.extend({
		and: z.array(child).min(1).max(MAX_FILTER_NODES).optional(),
		or: z.array(child).min(1).max(MAX_FILTER_NODES).optional(),
		not: child.optional(),
	})
}

function withinFilterBudget(value: FilterTree, selectedKeys: readonly string[]): boolean {
	type BudgetEntry = {
		value: FilterTree
		depth: number
		structuralDepth: number
		context: 'expression' | 'fields' | 'predicate' | 'composition' | 'value'
	}
	const pending: BudgetEntry[] = [{ value, depth: 0, structuralDepth: 0, context: 'expression' }]
	let nodes = 0
	while (pending.length > 0) {
		const entry = pending.pop()!
		if (
			++nodes > MAX_FILTER_NODES ||
			entry.depth > MAX_FILTER_DEPTH ||
			entry.structuralDepth > MAX_FILTER_DEPTH * 2 + 4
		)
			return false
		if (Object(entry.value) !== entry.value) continue
		// SAFETY: boxing equality above excludes null and all primitives.
		const object = entry.value as FilterTree[] | { [key: string]: FilterTree }
		const array = Array.isArray(object) ? object : undefined
		const prototype = Object.getPrototypeOf(object)
		if (
			array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
		)
			return false
		// Zod visits every array slot, including holes. Bound length before any
		// enumeration and accept only dense arrays with ordinary own data slots.
		if (array && array.length + nodes + pending.length > MAX_FILTER_NODES) return false
		const keys = Reflect.ownKeys(object)
		if (keys.length - (array ? 1 : 0) + nodes + pending.length > MAX_FILTER_NODES) return false
		if (array && keys.length !== array.length + 1) return false
		// Missing object fields are still read by Zod. Reject inherited fields that
		// the grammar consumes, including nonenumerable Object.prototype names.
		const consumed =
			entry.context === 'expression'
				? [...selectedKeys, 'and', 'or', 'not', 'fields']
				: entry.context === 'fields'
					? selectedKeys
					: entry.context === 'predicate'
						? ['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'exists']
						: []
		for (const key of consumed) {
			if (!Object.hasOwn(object, key) && key in object) return false
		}
		for (const key of keys) {
			if (array && key === 'length') continue
			const descriptor = Object.getOwnPropertyDescriptor(object, key)!
			const name = String(key)
			if (!descriptor.enumerable || !('value' in descriptor) || name !== key) return false
			if (array && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= array.length)) return false
			const child = descriptor.value
			let context: BudgetEntry['context'] = 'value'
			let depth = entry.depth
			if (entry.context === 'expression') {
				context = 'predicate'
				if (name === 'fields') context = 'fields'
				if (name === 'and' || name === 'or') {
					context = 'composition'
					depth++
				}
				if (name === 'not') {
					context = 'expression'
					depth++
				}
			} else if (entry.context === 'fields') context = 'predicate'
			else if (entry.context === 'composition') context = 'expression'
			pending.push({ value: child, depth, structuralDepth: entry.structuralDepth + 1, context })
		}
	}
	return true
}
