import { v } from 'convex/values'
import type { GenericValidator, PropertyValidators } from 'convex/values'
import type { AnySchema } from './schema'
import type { KFields, KLiteralValue, KRequiredValidator } from './types'

/** Native validators are immutable, so every nullable shares one null member. */
const nullNative = v.null()

/**
 * Build the input-side native validator for a chain record in one walk to its root. The root's validator
 * is memoised on the root, so check records reuse it; `nullable` wraps it and `optional`/`default` make it optional.
 */
export function compileNative(node: AnySchema): GenericValidator {
	let optional = false
	let nullable = false
	let root = node
	while (root.prev !== null) {
		if (root.op === 'optional' || root.op === 'default') optional = true
		else if (root.op === 'nullable') nullable = true
		root = root.prev
	}
	// SAFETY: root validators are never optional; only optional/default records make a chain optional.
	let native = (root.native ??= compileRoot(root)) as KRequiredValidator
	if (nullable) native = v.union(native, nullNative)
	return optional ? v.optional(native) : native
}

function compileRoot(node: AnySchema): KRequiredValidator {
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
			return v.array(requiredOf(node.arg as AnySchema))
		case 'object':
			// SAFETY: k.object stores its field schemas as the root argument.
			return v.object(compileFields(node.arg as KFields))
		case 'union':
			// SAFETY: k.union stores its member schemas as the root argument.
			return v.union(...(node.arg as readonly AnySchema[]).map(requiredOf))
		default:
			throw new Error(`k: '${node.op}' is not a root operation`)
	}
}

function requiredOf(node: AnySchema): KRequiredValidator {
	const native = node.validator
	// SAFETY: an optional validator's required form is rebuilt only for the rare optional array element or union member.
	return native.isOptional === 'optional' ? requiredCopy(node) : (native as KRequiredValidator)
}

function requiredCopy(node: AnySchema): KRequiredValidator {
	let nullable = false
	let root = node
	while (root.prev !== null) {
		if (root.op === 'nullable') nullable = true
		root = root.prev
	}
	// SAFETY: root validators are never optional.
	const native = root.validator as KRequiredValidator
	return nullable ? v.union(native, nullNative) : native
}

function compileEnum(values: readonly string[]): KRequiredValidator {
	if (values.length === 1) return v.literal(values[0])
	const members: KRequiredValidator[] = []
	for (const value of values) members.push(v.literal(value))
	return v.union(...members)
}

function compileFields(fields: KFields): PropertyValidators {
	const out: Record<string, GenericValidator> = {}
	for (const key in fields) out[key] = fields[key].validator
	return out
}
