import { v } from 'convex/values'
import { isFieldName } from './names'
import type { GenericValidator, PropertyValidators } from 'convex/values'
import type {
	KDiscriminated,
	KFields,
	KLiteralValue,
	KNode,
	KRequiredValidator,
	KType,
} from './types'

/** Native validators are immutable, so every nullable shares one null member and every transform one any. */
const nullNative = v.null()
const anyNative = v.any()

/**
 * Build the input-side native validator for a chain record in one walk to its root. The root's validator
 * is memoised on the root, so check records reuse it; `nullable` wraps it and `optional`/`default` make it
 * optional. Transform and pipe records keep their input schema's validator.
 */
export function compileNative(node: KNode): GenericValidator {
	let optional = false
	let nullable = false
	let root = node
	while (root.prev !== null) {
		if (root.op === 'optional' || root.op === 'partial' || root.op === 'default') optional = true
		else if (root.op === 'nullable') nullable = true
		root = root.prev
	}
	// SAFETY: root validators are never optional; only optional/default records make a chain optional.
	let native = (root.native ??= compileRoot(root)) as KRequiredValidator
	if (nullable) native = v.union(native, nullNative)
	return optional ? v.optional(native) : native
}

/**
 * Build the output-side native validator: a defaulted chain is required, a transform is `v.any()` and a
 * pipe is its target's output side. A chain whose output side equals its input side returns the very
 * same validator instance.
 */
export function compileOutput(node: KNode): GenericValidator {
	return outputOf(node, false)
}

/** The members of a union or discriminated union root. */
export function membersOf(root: KNode): readonly KNode[] {
	if (root.op === 'union') {
		// SAFETY: k.union stores its member schemas as the root argument.
		return root.arg as readonly KType[]
	}
	// SAFETY: k.discriminatedUnion stores its key and object options as the root argument.
	const arg = root.arg as KDiscriminated
	return arg.options
}

function outputOf(node: KNode, required: boolean): GenericValidator {
	if (node.prev === null) return compileRootOutput(node)
	let optional: boolean | undefined
	let nullable = false
	let differs = false
	let base: KRequiredValidator | undefined
	let current: KNode = node
	while (base === undefined) {
		if (current.prev === null) {
			// SAFETY: a root's output validator is never optional.
			base = outputOfNode(current) as KRequiredValidator
			if (base !== current.validator) differs = true
			break
		}
		if (current.op === 'optional' || current.op === 'partial') optional ??= true
		else if (current.op === 'default') {
			optional ??= false
			differs = true
		} else if (current.op === 'nullable') nullable = true
		else if (current.op === 'transform') {
			base = anyNative
			differs = true
		} else if (current.op === 'pipe') {
			// SAFETY: a pipe record stores its target schema as its argument.
			base = requiredOutput(current.arg as KNode)
			differs = true
		}
		current = current.prev
	}
	if (!differs && !required) return node.validator
	if (nullable) base = v.union(base, nullNative)
	return optional === true && !required ? v.optional(base) : base
}

function outputOfNode(node: KNode): GenericValidator {
	return (node.outputNative ??= compileOutput(node))
}

function compileRootOutput(root: KNode): GenericValidator {
	switch (root.op) {
		case 'object': {
			// SAFETY: k.object stores its field schemas as the root argument.
			const fields = root.arg as KFields
			const out: Record<string, GenericValidator> = {}
			let differs = false
			for (const key in fields) {
				const field = fields[key]
				const output = outputOfNode(field)
				if (output !== field.validator) differs = true
				out[key] = output
			}
			return differs ? v.object(out) : root.validator
		}
		case 'array': {
			// SAFETY: k.array stores its element schema as the root argument.
			const element = root.arg as KNode
			const output = requiredOutput(element)
			return output === requiredOf(element) ? root.validator : v.array(output)
		}
		case 'record': {
			// SAFETY: k.record stores its key and value schemas as the root argument.
			const [key, value] = root.arg as readonly KType[]
			const output = requiredOutput(value)
			return output === requiredOf(value) ? root.validator : v.record(requiredOf(key), output)
		}
		case 'union':
		case 'discriminatedUnion': {
			const members = membersOf(root)
			const outputs: KRequiredValidator[] = []
			let differs = false
			for (const member of members) {
				const output = requiredOutput(member)
				if (output !== requiredOf(member)) differs = true
				outputs.push(output)
			}
			return differs ? v.union(...outputs) : root.validator
		}
		default:
			return root.validator
	}
}

function compileRoot(node: KNode): KRequiredValidator {
	switch (node.op) {
		case 'string':
		case 'isoDate':
		case 'isoDateTime':
			return v.string()
		case 'number':
		case 'int':
		case 'timestamp':
			return v.number()
		case 'int64':
			return v.int64()
		case 'boolean':
			return v.boolean()
		case 'null':
			return v.null()
		case 'bytes':
			return v.bytes()
		case 'any':
			return v.any()
		case 'json':
			return v.union(
				v.string(),
				v.number(),
				v.boolean(),
				v.null(),
				v.array(v.any()),
				v.record(v.string(), v.any()),
			)
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
			return v.array(requiredOf(node.arg as KNode))
		case 'object':
			// SAFETY: k.object stores its field schemas as the root argument.
			return v.object(compileFields(node.arg as KFields))
		case 'record': {
			// SAFETY: k.record stores its key and value schemas as the root argument.
			const [key, value] = node.arg as readonly KType[]
			return v.record(requiredOf(key), requiredOf(value))
		}
		case 'union':
		case 'discriminatedUnion':
			return v.union(...membersOf(node).map(requiredOf))
		default:
			throw new Error(`k: '${node.op}' is not a root operation`)
	}
}

function requiredOf(node: KNode): KRequiredValidator {
	const native = node.validator
	// SAFETY: an optional validator's required form is rebuilt only for the rare optional array element or union member.
	return native.isOptional === 'optional' ? requiredCopy(node) : (native as KRequiredValidator)
}

function requiredOutput(node: KNode): KRequiredValidator {
	const output = outputOfNode(node)
	if (output.isOptional === 'optional') {
		// SAFETY: outputOf with `required` never makes the validator optional.
		return outputOf(node, true) as KRequiredValidator
	}
	// SAFETY: the validator is not optional, checked above.
	return output as KRequiredValidator
}

function requiredCopy(node: KNode): KRequiredValidator {
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
	const members: KRequiredValidator[] = []
	for (const value of values) members.push(v.literal(value))
	return v.union(...members)
}

function compileFields(fields: KFields): PropertyValidators {
	const out: Record<string, GenericValidator> = {}
	for (const key in fields) {
		if (!isFieldName(key))
			throw new Error(
				`k.object() field '${key}' is not a valid Convex field name: non-empty printable ASCII, at most 1024 characters, not starting with '$'`,
			)
		out[key] = fields[key].validator
	}
	return out
}
