import {
	convexToJson,
	jsonToConvex,
	type GenericId,
	type JSONValue,
	type ValidatorJSON,
	type GenericValidator,
	type Value,
} from 'convex/values'
import {
	k,
	type KBoolean,
	type KId,
	type KInt64,
	type KLiteral,
	type KNull,
	type KNumber,
	type KOptional,
	type KSchema,
	type KString,
	type KType,
} from '../../k'
import {
	boundedFilterSchema,
	normalizeFilters,
	scalarPredicateFromSchema,
	unionOf,
	type FilterTree,
	type KFilterSchema,
} from './filters'
import { evaluateFilter } from './evaluate'

type RequiredSharedField<V extends GenericValidator> = V extends { kind: 'string' }
	? KString
	: V extends { kind: 'float64' }
		? KNumber
		: V extends { kind: 'int64' }
			? KInt64
			: V extends { kind: 'boolean' }
				? KBoolean
				: V extends { kind: 'null' }
					? KNull
					: V extends { kind: 'literal'; value: infer L extends string | number | bigint | boolean }
						? KLiteral<L>
						: V extends { kind: 'id'; type: infer I }
							? KId<Extract<I, GenericId<string>> extends GenericId<infer T> ? T : string>
							: V extends { kind: 'union' }
								? KSchema<Exclude<V['type'], undefined>>
								: never
/** The `k` schema a shared filter contract generates for one native scalar validator. */
export type SharedField<V extends GenericValidator> = V extends { isOptional: 'optional' }
	? KOptional<RequiredSharedField<V>>
	: RequiredSharedField<V>
type FieldSchemas<F extends Record<string, GenericValidator>> = {
	[K in keyof F]: SharedField<F[K]>
}
type FilterSide = 'input' | 'output'
type InputValue<V> = V extends GenericId<string> ? string : V
type Scalar<V extends GenericValidator, S extends FilterSide> = S extends 'input'
	? InputValue<Exclude<V['type'], undefined>>
	: Exclude<V['type'], undefined>
type Ordered<V extends GenericValidator> = [GenericValidator] extends [V]
	? false
	: V extends { kind: 'string' | 'float64' | 'int64' }
		? true
		: V extends { kind: 'literal' }
			? Exclude<V['type'], undefined> extends string | number | bigint
				? true
				: false
			: V extends { kind: 'union'; members: infer M extends GenericValidator[] }
				? false extends Ordered<M[number]>
					? false
					: true
				: false
type Predicate<V extends GenericValidator, S extends FilterSide> =
	| Scalar<V, S>
	| ({ eq?: Scalar<V, S>; in?: Scalar<V, S>[] } & (Ordered<V> extends true
			? { gt?: Scalar<V, S>; gte?: Scalar<V, S>; lt?: Scalar<V, S>; lte?: Scalar<V, S> }
			: {}) &
			(V['isOptional'] extends 'optional' ? { exists?: boolean } : {}))
type Fields<F extends Record<string, GenericValidator>, S extends FilterSide> = {
	[K in keyof F]?: Predicate<F[K], S>
}
type Tail<D extends 1[]> = D extends [1, ...infer R extends 1[]] ? R : []
export type SharedFilters<
	F extends Record<string, GenericValidator>,
	S extends FilterSide = 'output',
	D extends 1[] = [1, 1, 1, 1],
> = Omit<Fields<F, S>, 'and' | 'or' | 'not' | 'fields'> & { fields?: Fields<F, S> } & (D extends []
		? {}
		: {
				and?: SharedFilters<F, S, Tail<D>>[]
				or?: SharedFilters<F, S, Tail<D>>[]
				not?: SharedFilters<F, S, Tail<D>>
			})
export interface FilterDescriptor {
	field: string
	kind: 'string' | 'number' | 'bigint' | 'boolean' | 'null' | 'id' | 'enum' | 'union'
	optional: boolean
	nullable: boolean
	values?: readonly (string | number | bigint | boolean)[]
	idTables: readonly string[]
	operators: readonly string[]
	members?: readonly FilterDescriptor[]
}
export interface FilterContract<F extends Record<string, GenericValidator>> {
	readonly fields: FieldSchemas<F>
	readonly native: Readonly<Record<string, { json: ValidatorJSON; optional: boolean }>>
	readonly schema: KFilterSchema<SharedFilters<F>>
	describe(): readonly FilterDescriptor[]
	evaluate(
		filters: SharedFilters<F, 'input'>,
		document: Record<string, Value | undefined>,
		accessible?: ReadonlySet<string>,
	): boolean | 'unknown'
	readonly searchParam: {
		encode(
			value: SharedFilters<F, 'input'>,
		): { success: true; value: string } | { success: false; error: string }
		decode(
			value: string,
		): { success: true; value: SharedFilters<F> } | { success: false; error: string }
	}
}

/** Scalar-only contracts explicitly reject objects, arrays, relations and variants. */
export function defineFilterContract<const F extends Record<string, GenericValidator>>(
	input: F,
): FilterContract<F> {
	const fields: Record<string, KType> = {},
		predicates: Record<string, KType> = {}
	const native: Record<string, { json: ValidatorJSON; optional: boolean }> = {}
	const descriptors: FilterDescriptor[] = []
	for (const [field, validator] of Object.entries(input)) {
		if (['__proto__', 'constructor', 'prototype'].includes(field))
			throw new Error('Unsupported filter field')
		const scalar = scalarSchema(validator)
		fields[field] = validator.isOptional === 'optional' ? schemaOf(scalar).optional() : scalar
		const operators = ['eq', 'in']
		if (ordered(validator)) operators.push('gt', 'gte', 'lt', 'lte')
		if (validator.isOptional === 'optional') operators.push('exists')
		predicates[field] = schemaOf(
			scalarPredicateFromSchema(scalar, ordered(validator), validator.isOptional === 'optional'),
		).optional()
		native[field] = { json: nativeJson(validator), optional: validator.isOptional === 'optional' }
		descriptors.push(describe(field, validator, operators))
	}
	// SAFETY: every selected native scalar generates precisely the mapped predicate grammar.
	const schema = boundedFilterSchema(predicates) as KFilterSchema<SharedFilters<F>>
	const encode = (value: SharedFilters<F, 'input'>) => {
		// SAFETY: bounded scalar schema outputs contain only Convex scalar values and containers.
		try {
			// SAFETY: the input boundary inspects descriptors before parsing or serializing.
			if (!withinUrlSize(value as FilterTree)) throw new Error('URL size exceeded')
			const parsed = schema.parse(value)
			// SAFETY: bounded schema output contains only Convex values.
			const encoded = JSON.stringify({ v: 1, filters: canonical(convexToJson(parsed as Value)) })
			if (encoded.length > 32768) throw new Error('URL size exceeded')
			return { success: true as const, value: encoded }
		} catch {
			return { success: false as const, error: 'Invalid filters' }
		}
	}
	const decode = (value: string) => {
		try {
			if (value.length > 32768) throw new Error('URL size exceeded')
			const envelope = JSON.parse(value)
			if (!envelope || envelope.v !== 1 || Object.keys(envelope).sort().join(',') !== 'filters,v')
				throw new Error('Unsupported URL version')
			guardJson(envelope.filters)
			const parsed = schema.parse(jsonToConvex(envelope.filters))
			return { success: true as const, value: parsed }
		} catch {
			return { success: false as const, error: 'Invalid filter URL' }
		}
	}
	return Object.freeze({
		// SAFETY: fields were generated from their corresponding native validator types.
		fields: Object.freeze(fields) as FieldSchemas<F>,
		native: freezeMetadata(native),
		schema,
		describe: () => structuredClone(descriptors),
		// SAFETY: the bounded scalar schema validates the tree before normalization.
		evaluate: (
			filters: SharedFilters<F, 'input'>,
			document: Record<string, Value | undefined>,
			accessible?: ReadonlySet<string>,
		) =>
			evaluateFilter(normalizeFilters(schema.parse(filters) as FilterTree), document, accessible),
		searchParam: Object.freeze({ encode, decode }),
	})
}
/** Signed 64-bit range, which Convex's int64 enforces on write and v1's contract checked on parse. */
const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n

/** Read the native declaration once: later edits to the caller's validators cannot reach the contract. */
function scalarSchema(validator: GenericValidator): KType {
	switch (validator.kind) {
		case 'string':
			return k.string()
		case 'float64':
			return k.number().refine(Number.isFinite, 'Invalid input: expected a finite number')
		case 'int64':
			return k
				.int64()
				.refine(
					(value) => value >= INT64_MIN && value <= INT64_MAX,
					'Expected a signed 64-bit integer',
				)
		case 'boolean':
			return k.boolean()
		case 'null':
			return k.null()
		case 'literal':
			return k.literal(validator.value)
		case 'id':
			return k.id(validator.tableName)
		case 'union':
			return unionOf(validator.members.map(scalarSchema))
		default:
			throw new Error(
				`Unsupported shared scalar kind "${validator.kind}"; relations and variants require a server contract`,
			)
	}
}
function ordered(validator: GenericValidator): boolean {
	return (
		['string', 'float64', 'int64'].includes(validator.kind) ||
		(validator.kind === 'literal' && orderedLiteral(validator.value)) ||
		(validator.kind === 'union' && validator.members.every(ordered))
	)
}
function describe(
	field: string,
	validator: GenericValidator,
	operators: string[],
): FilterDescriptor {
	const children =
		validator.kind === 'union'
			? validator.members.map((v) => describe(field, v, operators))
			: undefined
	const literals = children?.every((c) => c.kind === 'enum')
	const kind =
		validator.kind === 'float64'
			? 'number'
			: validator.kind === 'int64'
				? 'bigint'
				: validator.kind === 'literal'
					? 'enum'
					: literals
						? 'enum'
						: validator.kind
	// SAFETY: unsupported native kinds were rejected while generating scalar schemas.
	return {
		field,
		kind: kind as FilterDescriptor['kind'],
		optional: validator.isOptional === 'optional',
		nullable: validator.kind === 'null' || !!children?.some((c) => c.nullable),
		values:
			validator.kind === 'literal'
				? [validator.value]
				: literals
					? children!.flatMap((c) => c.values ?? [])
					: undefined,
		idTables:
			validator.kind === 'id'
				? [validator.tableName]
				: (children?.flatMap((c) => c.idTables) ?? []),
		operators,
		members: children,
	}
}
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Serialized Convex JSON contains only validated JSON containers and scalars.
function canonical(value: JSONValue): JSONValue {
	if (Array.isArray(value)) return value.map(canonical)
	// SAFETY: arrays were handled; the remaining JSON object supports string-key lookup.
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Traverse JSON containers before canonical encoding.
	if (value && typeof value === 'object') {
		// SAFETY: arrays were handled, leaving a JSON object with string keys.
		const object = value as Record<string, JSONValue>
		return Object.fromEntries(
			Object.keys(object)
				.sort()
				.map((k) => [k, canonical(object[k])]),
		)
	}
	return value
}
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Bound untrusted JSON before Convex decoding or recursive schema validation.
function guardJson(value: JSONValue, depth = 0, state = { nodes: 0 }): void {
	if (depth > 16 || ++state.nodes > 2048) throw new Error('URL budget exceeded')
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Traverse only JSON containers or owned metadata; no domain narrowing occurs.
	if (value && typeof value === 'object')
		for (const child of Object.values(value)) guardJson(child, depth + 1, state)
}

function nativeJson(validator: GenericValidator): ValidatorJSON {
	// SAFETY: native scalar validators expose json at runtime, stripped from declarations.
	return (validator as GenericValidator & { json: ValidatorJSON }).json
}
function freezeMetadata<T>(value: T): T {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Traverse only JSON containers or owned metadata; no domain narrowing occurs.
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) freezeMetadata(child)
		Object.freeze(value)
	}
	return value
}

function withinUrlSize(value: FilterTree): boolean {
	const pending = [value]
	let size = 0,
		nodes = 0
	while (pending.length) {
		const current = pending.pop()
		if (++nodes > 512) return false
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Count raw scalar text before any serialization allocation.
		if (typeof current === 'string') {
			size += current.length
			if (size > 32768) return false
		}
		if (Object(current) !== current) continue
		// SAFETY: boxing excluded null and primitives; inspect data descriptors without invoking getters.
		const object = current as object
		const keys = Reflect.ownKeys(object)
		if (keys.length + nodes + pending.length > 512) return false
		for (const key of keys) {
			if (Array.isArray(object) && key === 'length') continue
			const descriptor = Object.getOwnPropertyDescriptor(object, key)
			if (!descriptor || !('value' in descriptor)) return false
			size += String(key).length
			if (size > 32768) return false
			pending.push(descriptor.value)
		}
	}
	return true
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
