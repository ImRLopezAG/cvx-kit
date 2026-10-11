import {
	zodToConvex as helperZodToConvex,
	type ConvexValidatorFromZod,
} from 'convex-helpers/server/zod4'
import { vRequired } from 'convex-helpers/validators'
import { v, type GenericValidator } from 'convex/values'
import { z } from 'zod'

/** Convert Zod inputs with the helper's grammar and native ID registry.
 * Repeated filter containers share completed native validators within this call.
 * Other schemas retain the helper's conversion behavior, including its errors.
 */
export function zodToConvex<Z extends z.core.$ZodType>(
	schema: Z,
): ConvexValidatorFromZod<Z, 'required'> {
	const completed = new WeakMap<z.core.$ZodType, GenericValidator>()
	const ancestors = new WeakSet<z.core.$ZodType>()

	function convert(node: z.core.$ZodType): GenericValidator {
		if (ancestors.has(node)) throw new Error('CYCLIC_FILTER_SCHEMA')
		const cached = completed.get(node)
		if (cached) return cached
		ancestors.add(node)
		try {
			let result: GenericValidator
			// Public core definitions work for both standard Zod and Zod Mini.
			if (node instanceof z.core.$ZodObject) {
				result = v.object(
					Object.fromEntries(
						Object.entries(node._zod.def.shape).map(([key, child]) => [key, convert(child)]),
					),
				)
			} else if (node instanceof z.core.$ZodArray) {
				const inner = convert(node._zod.def.element)
				if (inner.isOptional === 'optional') {
					throw new Error('Arrays of optional values are not supported')
				}
				result = v.array(inner)
			} else if (node instanceof z.core.$ZodUnion) {
				result = v.union(...node._zod.def.options.map(convert))
			} else if (node instanceof z.core.$ZodOptional) {
				result = v.optional(convert(node._zod.def.innerType))
			} else if (node instanceof z.core.$ZodNonOptional) {
				result = vRequired(convert(node._zod.def.innerType))
			} else if (node instanceof z.core.$ZodNullable) {
				const inner = convert(node._zod.def.innerType)
				result =
					inner.isOptional === 'optional'
						? v.optional(v.union(vRequired(inner), v.null()))
						: v.union(inner, v.null())
			} else {
				// Keep arbitrary non-filter schemas and native IDs helper-owned.
				return helperZodToConvex(node)
			}
			// Never publish a partial validator; ancestor cycles fail before reuse.
			completed.set(node, result)
			return result
		} finally {
			ancestors.delete(node)
		}
	}
	// SAFETY: handled containers mirror helper conversion; all other nodes delegate
	// to that helper, retaining its original input-side validator type relationship.
	return convert(schema) as ConvexValidatorFromZod<Z, 'required'>
}
