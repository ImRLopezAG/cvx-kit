import { z } from 'zod'
import {
	v,
	ConvexError,
	type Value,
	type GenericValidator,
	type PropertyValidators,
} from 'convex/values'
import { vRequired } from 'convex-helpers/validators'
import { zodToConvex } from '../zod-convex'
import { compactFilterMetadata, MAX_FILTER_DEPTH, type FilterGrammar } from './shared/filters'

/** Private projection. The caller must install the captured semantic preflight. */
export function compactNativeFilter(schema: z.core.$ZodType): GenericValidator | undefined {
	const metadata = compactFilterMetadata(schema)
	if (!metadata) return undefined
	const completed = new WeakMap<FilterGrammar, Map<number, GenericValidator>>()
	const predicates = new WeakMap<FilterGrammar, PropertyValidators>()
	function fields(grammar: FilterGrammar): PropertyValidators {
		const cached = predicates.get(grammar)
		if (cached) return cached
		const result = Object.fromEntries(
			Object.entries(grammar.fields).map(([k, s]) => [k, zodToConvex(s)]),
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

/** Conversion and preflight are one registration decision. Unsupported wrappers
 * stay on the ordinary converter and never acquire a compact guard. */
interface ArgumentBoundary {
	validator: Extract<GenericValidator, { kind: 'object' }>
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the parser boundary for raw registered arguments.
	preflight(value: unknown): void
}
export function compactArgumentBoundary(schema: z.core.$ZodObject): ArgumentBoundary {
	const full = zodToConvex(schema)
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Guards parse untrusted registered values before customization.
	type Guard = (value: unknown, path: string[]) => void
	interface Pair {
		validator: GenericValidator
		guard?: Guard
	}
	const completed = new WeakMap<z.core.$ZodType, Pair>()
	function visit(node: z.core.$ZodType, native: GenericValidator): Pair {
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
						throw new ConvexError({
							// SAFETY: serialized issues are the existing helper-compatible Convex Value error payload.
							ZodError: JSON.parse(
								JSON.stringify(
									parsed.error.issues.map((issue) => ({
										...issue,
										path: [...path, ...issue.path],
									})),
								),
							) as Value[],
						})
				},
			}
		} else if (node instanceof z.core.$ZodOptional) {
			const child = visit(node._zod.def.innerType, vRequired(native))
			if (child.guard)
				result = {
					validator: v.optional(child.validator),
					guard: (value, path) => {
						if (value !== undefined) child.guard!(value, path)
					},
				}
		} else if (node instanceof z.core.$ZodObject && native.kind === 'object') {
			const children = Object.entries(node._zod.def.shape).map(
				([key, child]) => [key, visit(child, native.fields[key])] as const,
			)
			if (children.some(([, child]) => child.guard))
				result = {
					validator: v.object(
						Object.fromEntries(children.map(([key, child]) => [key, child.validator])),
					),
					guard: (value, path) => {
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
		completed.set(node, result)
		return result
	}
	const pair = visit(schema, full)
	if (pair.validator.kind !== 'object') throw new Error('Expected object argument boundary')
	return {
		validator: pair.validator,
		preflight(value) {
			pair.guard?.(value, [])
		},
	}
}

function layoutError(path: string[]): never {
	throw new ConvexError({
		ZodError: [
			{ code: 'custom', path, message: 'Unsupported filter layout or depth/node budget exceeded' },
		],
	})
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
