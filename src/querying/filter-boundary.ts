/* oxlint-disable anti-slop/no-unknown-parameters -- The preflight receives raw registered arguments before any schema has decoded them. */
import { v, type GenericValidator, type PropertyValidators } from 'convex/values'
import { vRequired } from 'convex-helpers/validators'
import { KValidationError, type KPath, type KType } from '../k'
import { compactFilterMetadata, MAX_FILTER_DEPTH, type FilterGrammar } from './shared/filters'

/** Private projection. The caller must install the captured semantic preflight. */
export function compactNativeFilter(schema: KType): GenericValidator | undefined {
	const metadata = compactFilterMetadata(schema)
	if (!metadata) return undefined
	const completed = new WeakMap<FilterGrammar, Map<number, GenericValidator>>()
	const predicates = new WeakMap<FilterGrammar, PropertyValidators>()
	function fields(grammar: FilterGrammar): PropertyValidators {
		const cached = predicates.get(grammar)
		if (cached) return cached
		const result = Object.fromEntries(
			Object.entries(grammar.fields).map(([key, schema]) => [key, schema.validator]),
		)
		predicates.set(grammar, result)
		return result
	}
	function needsIds(grammar: FilterGrammar, depth: number): boolean {
		if (Object.values(fields(grammar)).some(hasId)) return true
		return (
			depth < MAX_FILTER_DEPTH &&
			(Object.values(grammar.relations).some((r) => needsIds(r.target, depth + 1)) ||
				Object.values(grammar.variants?.options ?? {}).some((g) => needsIds(g, depth + 1)))
		)
	}
	function expression(grammar: FilterGrammar, depth: number): GenericValidator {
		const cached = completed.get(grammar)?.get(depth)
		if (cached) return cached
		if (depth > 1 && !needsIds(grammar, depth)) return v.any()
		const selected = Object.fromEntries(
			Object.entries(fields(grammar)).map(([key, value]) => [
				key,
				depth <= 1 || hasId(value)
					? value
					: value.isOptional === 'optional'
						? v.optional(v.any())
						: v.any(),
			]),
		)
		const direct = Object.fromEntries(
			Object.entries(selected).filter(
				([key]) =>
					!['and', 'or', 'not', 'fields', ...(grammar.variants ? ['variant'] : [])].includes(key),
			),
		)
		const properties: PropertyValidators = { ...direct, fields: v.optional(v.object(selected)) }
		if (depth < MAX_FILTER_DEPTH) {
			for (const [name, relation] of Object.entries(grammar.relations)) {
				const target = expression(relation.target, depth + 1)
				properties[name] = v.optional(
					relation.cardinality === 'one'
						? v.union(target, v.null())
						: v.union(v.object({ some: target }), v.object({ none: target })),
				)
			}
			if (grammar.variants && Object.keys(grammar.variants.options).length)
				properties.variant = v.optional(
					v.union(
						...Object.entries(grammar.variants.options).map(([tag, branch]) =>
							v.object({ tag: v.literal(tag), filters: expression(branch, depth + 1) }),
						),
					),
				)
			const child = expression(grammar, depth + 1)
			properties.and = v.optional(v.array(child))
			properties.or = v.optional(v.array(child))
			properties.not = v.optional(child)
		}
		const result = v.object(properties)
		let depths = completed.get(grammar)
		if (!depths) {
			depths = new Map()
			completed.set(grammar, depths)
		}
		depths.set(depth, result)
		return result
	}
	function known(grammar: FilterGrammar, depth: number): boolean {
		return (
			Object.values(fields(grammar)).every(knownNative) &&
			(depth === MAX_FILTER_DEPTH ||
				(Object.values(grammar.relations).every((relation) => known(relation.target, depth + 1)) &&
					Object.values(grammar.variants?.options ?? {}).every((branch) =>
						known(branch, depth + 1),
					)))
		)
	}
	return known(metadata.grammar, 0) ? expression(metadata.grammar, 0) : undefined
}

/**
 * Conversion and preflight are one registration decision. `validator` is what Convex receives: the
 * declared args with each compact filter projected; `preflight` runs the full structural walker
 * (KTD3) on exactly those projected filters, before customization, and raises the KTD6 error.
 */
export interface ArgumentBoundary {
	readonly validator: Extract<GenericValidator, { kind: 'object' }>
	preflight(value: unknown): void
}

/**
 * The compact projection of an args object, or undefined when no field holds a compact filter.
 * `fields` are the `k` argument fields; `full` builds the native args validator, which may also hold
 * native fields beside them. Args without a compact filter build no native validator here.
 */
export function compactArgumentBoundary(
	fields: Readonly<Record<string, KType>>,
	full: () => Extract<GenericValidator, { kind: 'object' }>,
): ArgumentBoundary | undefined {
	if (!Object.values(fields).some((field) => holdsCompactFilter(field, new Set()))) return undefined
	type Guard = (value: unknown, path: KPath) => void
	interface Pair {
		validator: GenericValidator
		guard?: Guard
	}
	const completed = new WeakMap<KType, Pair>()
	function visit(node: KType, native: GenericValidator): Pair {
		const cached = completed.get(node)
		if (cached) return cached
		const metadata = compactFilterMetadata(node)
		const projected = metadata && compactNativeFilter(node)
		let result: Pair = { validator: native }
		if (projected && metadata) {
			result = {
				validator: projected,
				guard: (value, path) => {
					const parsed = metadata.semantic.safeParse(value)
					if (!parsed.success)
						throw new KValidationError(
							parsed.issues.map((issue) => ({ ...issue, path: [...path, ...issue.path] })),
						)
				},
			}
		} else if ((node.op === 'optional' || node.op === 'partial') && node.prev !== null) {
			const child = visit(schemaOf(node.prev), vRequired(native))
			if (child.guard)
				result = {
					validator: v.optional(child.validator),
					guard: (value, path) => {
						if (value !== undefined) child.guard!(value, path)
					},
				}
		} else if (native.kind === 'object') {
			const memberFields = objectFields(node)
			if (memberFields) result = objectPair(memberFields, native, visit) ?? result
		}
		completed.set(node, result)
		return result
	}
	const pair = objectPair(fields, full(), visit)
	if (!pair?.guard) return undefined
	const guard = pair.guard
	if (pair.validator.kind !== 'object') throw new Error('Expected object argument boundary')
	return {
		validator: pair.validator,
		preflight(value) {
			guard(value, [])
		},
	}
}

/** The pair for an object whose `k` fields are `memberFields`; native-only fields keep their validators. */
function objectPair(
	memberFields: Readonly<Record<string, KType>>,
	native: Extract<GenericValidator, { kind: 'object' }>,
	visit: (
		node: KType,
		native: GenericValidator,
	) => { validator: GenericValidator; guard?: (value: unknown, path: KPath) => void },
) {
	const children = Object.entries(memberFields).map(
		([key, child]) => [key, visit(child, native.fields[key])] as const,
	)
	if (!children.some(([, child]) => child.guard)) return undefined
	return {
		validator: v.object({
			...native.fields,
			...Object.fromEntries(children.map(([key, child]) => [key, child.validator])),
		}),
		guard: (value: unknown, path: KPath) => {
			if (value === null || Object(value) !== value || Array.isArray(value)) layoutError(path)
			// SAFETY: the boxing check above excludes primitive argument containers.
			const object = value as object
			const prototype = Object.getPrototypeOf(object)
			if (prototype !== Object.prototype && prototype !== null) layoutError(path)
			for (const [key, child] of children)
				if (child.guard) {
					const descriptor = Object.getOwnPropertyDescriptor(object, key)
					if (descriptor && (!('value' in descriptor) || !descriptor.enumerable))
						layoutError([...path, key])
					if (!descriptor && key in object) layoutError([...path, key])
					child.guard(descriptor?.value, [...path, key])
				}
		},
	}
}

/** Whether a compact filter sits in `node`, through the optional and object records `visit` follows. */
function holdsCompactFilter(node: KType, seen: Set<KType>): boolean {
	if (seen.has(node)) return false
	seen.add(node)
	if (compactFilterMetadata(node)) return true
	if ((node.op === 'optional' || node.op === 'partial') && node.prev !== null)
		return holdsCompactFilter(schemaOf(node.prev), seen)
	const memberFields = objectFields(node)
	return (
		memberFields !== undefined &&
		Object.values(memberFields).some((child) => holdsCompactFilter(child, seen))
	)
}

function layoutError(path: KPath): never {
	throw new KValidationError([
		{ code: 'custom', path, message: 'Unsupported filter layout or depth/node budget exceeded' },
	])
}

/** The field map of an object schema, through validation-only records chained on its root. */
function objectFields(schema: KType): Readonly<Record<string, KType>> | undefined {
	let current: KType = schema
	while (current.prev !== null) {
		if (!['describe', 'refine', 'check', 'strip'].includes(current.op)) return undefined
		current = schemaOf(current.prev)
	}
	if (current.op !== 'object') return undefined
	// SAFETY: k.object stores its field map as the root argument.
	return current.arg as Readonly<Record<string, KType>>
}

function schemaOf(node: KType['prev'] & object): KType {
	// SAFETY: every record reachable from a k schema was created by a k factory.
	return node as KType
}

function knownNative(validator: GenericValidator): boolean {
	switch (validator.kind) {
		case 'union':
			return validator.members.every(knownNative)
		case 'object':
			return Object.values(validator.fields).every(knownNative)
		case 'array':
			return knownNative(validator.element)
		case 'id':
		case 'string':
		case 'float64':
		case 'int64':
		case 'boolean':
		case 'null':
		case 'literal':
			return true
		default:
			return false
	}
}

function hasId(validator: GenericValidator): boolean {
	switch (validator.kind) {
		case 'id':
			return true
		case 'union':
			return validator.members.some(hasId)
		case 'object':
			return Object.values(validator.fields).some(hasId)
		case 'array':
			return hasId(validator.element)
		default:
			return false
	}
}
