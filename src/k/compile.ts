import { v } from 'convex/values'
import type { GenericValidator, PropertyValidators, Validator } from 'convex/values'
import type { KSchema } from './schema'
import type { KFields, KLiteralValue, KType } from './types'

type RequiredValidator = Validator<any, 'required', any>

/** Build the input-side native validator for a chain record. A defaulted or optional chain is optional. */
export function compileNative(node: KSchema): GenericValidator {
	if (node.prev === null) return compileRoot(node)
	const inner = requiredOf(node)
	return isOptionalChain(node) ? v.optional(inner) : inner
}

function requiredOf(node: KSchema): RequiredValidator {
	if (node.prev === null) {
		// SAFETY: a root record is never optional; only optional/default records make a chain optional.
		return node.validator as RequiredValidator
	}
	if (node.op === 'nullable') return v.union(requiredOf(node.prev), v.null())
	return requiredOf(node.prev)
}

function isOptionalChain(node: KSchema): boolean {
	for (let current: KSchema | null = node; current !== null; current = current.prev) {
		if (current.op === 'optional' || current.op === 'default') return true
	}
	return false
}

function compileRoot(node: KSchema): RequiredValidator {
	switch (node.op) {
		case 'string':
			return v.string()
		case 'number':
		case 'int':
			return v.number()
		case 'boolean':
			return v.boolean()
		case 'null':
			return v.null()
		case 'literal':
			// SAFETY: k.literal stores its literal value as the root argument.
			return v.literal(node.arg as KLiteralValue)
		case 'id':
			// SAFETY: k.id stores its table name as the root argument.
			return v.id(node.arg as string)
		case 'enum':
			// SAFETY: k.enum stores its non-empty value list as the root argument.
			return compileEnum(node.arg as readonly string[])
		case 'array':
			// SAFETY: k.array stores its element schema as the root argument.
			return v.array(requiredOf(node.arg as KSchema))
		case 'object':
			// SAFETY: k.object stores its field schemas as the root argument.
			return v.object(compileFields(node.arg as KFields))
		case 'union':
			// SAFETY: k.union stores its member schemas as the root argument.
			return v.union(...(node.arg as readonly KSchema[]).map(requiredOf))
		default:
			throw new Error(`k: '${node.op}' is not a root operation`)
	}
}

function compileEnum(values: readonly string[]): RequiredValidator {
	if (values.length === 1) return v.literal(values[0])
	return v.union(...values.map(literalOf))
}

function literalOf(value: string): RequiredValidator {
	return v.literal(value)
}

function compileFields(fields: KFields): PropertyValidators {
	const out: Record<string, GenericValidator> = {}
	for (const key in fields) out[key] = validatorOf(fields[key])
	return out
}

function validatorOf(field: KType): GenericValidator {
	// SAFETY: every KType value at runtime is a KSchema instance created by a k factory.
	return (field as KSchema).validator
}
