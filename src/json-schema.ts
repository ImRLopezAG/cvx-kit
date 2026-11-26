/** JSON Schema for `k` schemas (KTD8): a separate entry, so core function bundles never load it. */
import type { JSONValue, Value } from 'convex/values'
import { membersOf } from './k/compile'
import { maxTimestamp } from './k/formats'
import type { KDiscriminated, KFields, KLiteralValue, KNode, KType } from './k/types'

/** The JSON Schema (draft 2020-12) subset `toJsonSchema` emits. */
export interface JsonSchema {
	$schema?: string
	type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object'
	format?: 'date' | 'date-time'
	contentEncoding?: 'base64'
	description?: string
	const?: JSONValue
	enum?: string[]
	default?: JSONValue
	minLength?: number
	maxLength?: number
	pattern?: string
	minimum?: number
	maximum?: number
	exclusiveMinimum?: number
	exclusiveMaximum?: number
	minItems?: number
	maxItems?: number
	items?: JsonSchema
	properties?: Record<string, JsonSchema>
	required?: string[]
	additionalProperties?: boolean | JsonSchema
	propertyNames?: JsonSchema
	anyOf?: JsonSchema[]
	oneOf?: JsonSchema[]
	allOf?: JsonSchema[]
}

export type JsonSchemaOptions = {
	/** Add `$schema: "https://json-schema.org/draft/2020-12/schema"` to the root. */
	readonly $schema?: boolean
	/**
	 * Which side to describe, as Zod's `io`. `'input'` (the default) is what a caller sends. `'output'`
	 * is what parse returns: a defaulted field is required, a pipe emits its target's output, and a
	 * transform emits `{}` (any value), as `outputValidator` emits `v.any()`.
	 */
	readonly io?: 'input' | 'output'
}

/**
 * The input-side JSON Schema of a `k` schema, for agent tool inputs and forms: optional and defaulted
 * fields are not required (a JSON-compatible default is emitted), ids are strings, transforms and pipes
 * emit their input schema, and descriptions come from `.describe()`. Custom refinements are not
 * expressible and are omitted.
 */
export function toJsonSchema(schema: KType, options?: JsonSchemaOptions): JsonSchema {
	const out = convert(schema, options?.io === 'output')
	if (options?.$schema === true)
		return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...out }
	return out
}

function convert(node: KNode, output: boolean): JsonSchema {
	const records: KNode[] = []
	for (let current: KNode | null = node; current !== null; current = current.prev)
		records.push(current)
	// SAFETY: a chain always ends at a root record.
	let out = rootSchema(records.pop() as KNode, output)
	let transformed = false
	let nullable = false
	let description: string | undefined
	let fallback: JSONValue | undefined
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]
		switch (record.op) {
			case 'transform':
				if (output) out = {}
				transformed = true
				break
			case 'pipe':
				if (output) out = convert(argNode(record.arg), true)
				transformed = true
				break
			case 'catch':
				// A fallback accepts any input; the output side is the wrapped schema.
				if (!output) {
					out = {}
					transformed = true
				}
				break
			case 'describe':
				description = textOf(record)
				break
			case 'nullable':
				nullable = true
				break
			case 'default':
				if (!transformed) fallback = jsonOf(defaultOf(record))
				break
			case 'min':
			case 'max':
			case 'length':
			case 'regex':
			case 'int':
			case 'gt':
			case 'lt':
			case 'safe':
				if (!transformed) applyCheck(out, record)
				break
			default:
				break
		}
	}
	const wrapped: JsonSchema = nullable ? { anyOf: [out, { type: 'null' }] } : out
	if (description !== undefined) wrapped.description = description
	if (fallback !== undefined) wrapped.default = fallback
	return wrapped
}

function rootSchema(root: KNode, output: boolean): JsonSchema {
	switch (root.op) {
		case 'string':
		case 'id':
			return { type: 'string' }
		case 'isoDate':
			return { type: 'string', format: 'date' }
		case 'isoDateTime':
			return { type: 'string', format: 'date-time' }
		case 'number':
			return { type: 'number' }
		case 'int':
		case 'int64':
			return { type: 'integer' }
		case 'timestamp':
			return { type: 'integer', minimum: 0, maximum: maxTimestamp }
		case 'boolean':
			return { type: 'boolean' }
		case 'null':
			return { type: 'null' }
		case 'bytes':
			return { type: 'string', contentEncoding: 'base64' }
		case 'any':
		case 'json':
			return {}
		case 'literal':
			return literalSchema(literalOf(root))
		case 'enum':
			// SAFETY: k.enum stores its value list as the root argument.
			return { type: 'string', enum: [...(root.arg as readonly string[])] }
		case 'array':
			return { type: 'array', items: convert(argNode(root.arg), output) }
		case 'object':
			return objectSchema(fieldsOf(root), output)
		case 'record': {
			// SAFETY: k.record stores its key and value schemas as the root argument.
			const [key, value] = root.arg as readonly KType[]
			return {
				type: 'object',
				propertyNames: convert(key, output),
				additionalProperties: convert(value, output),
			}
		}
		case 'union':
			return { anyOf: membersOf(root).map((member) => convert(member, output)) }
		case 'discriminatedUnion': {
			// SAFETY: k.discriminatedUnion stores its key and options as the root argument.
			const { options } = root.arg as KDiscriminated
			return { oneOf: options.map((option) => convert(option, output)) }
		}
		default:
			throw new Error(`toJsonSchema: '${root.op}' is not a root operation`)
	}
}

function objectSchema(fields: KFields, output: boolean): JsonSchema {
	const properties: Record<string, JsonSchema> = {}
	const required: string[] = []
	for (const key in fields) {
		properties[key] = convert(fields[key], output)
		if (output ? isRequiredOutput(fields[key]) : isRequired(fields[key])) required.push(key)
	}
	const out: JsonSchema = { type: 'object', properties, additionalProperties: false }
	if (required.length > 0) out.required = required
	return out
}

function isRequired(node: KNode): boolean {
	for (let current: KNode | null = node; current !== null; current = current.prev) {
		if (current.op === 'optional' || current.op === 'partial' || current.op === 'default')
			return false
	}
	return true
}

/** Required on the output side: parse fills a default, also below an `optional()`, but not below `partial()`. */
function isRequiredOutput(node: KNode): boolean {
	for (let current: KNode | null = node; current !== null; current = current.prev) {
		switch (current.op) {
			case 'partial':
				return false
			case 'optional':
				return defaultBelow(current.prev)
			case 'default':
			case 'transform':
			case 'pipe':
				return true
			default:
				break
		}
	}
	return true
}

function defaultBelow(node: KNode | null): boolean {
	for (let current = node; current !== null; current = current.prev) {
		if (current.op === 'default') return true
		if (current.op === 'transform' || current.op === 'pipe') return false
	}
	return false
}

function applyCheck(out: JsonSchema, record: KNode): void {
	if (record.op === 'int') {
		out.type = 'integer'
		return
	}
	if (record.op === 'safe') {
		out.type = 'integer'
		out.minimum = strongest(out.minimum, Number.MIN_SAFE_INTEGER, Math.max)
		out.maximum = strongest(out.maximum, Number.MAX_SAFE_INTEGER, Math.min)
		return
	}
	if (record.op === 'gt' || record.op === 'lt') {
		// SAFETY: gt and lt store their numeric limit as the record argument.
		const bound = record.arg as number
		if (record.op === 'gt') out.exclusiveMinimum = strongest(out.exclusiveMinimum, bound, Math.max)
		else out.exclusiveMaximum = strongest(out.exclusiveMaximum, bound, Math.min)
		return
	}
	if (record.op === 'regex') {
		// SAFETY: .regex stores its pattern as the record argument.
		const pattern = (record.arg as RegExp).source
		if (out.pattern === undefined) out.pattern = pattern
		else (out.allOf ??= []).push({ pattern })
		return
	}
	// SAFETY: min, max and length store their numeric limit as the record argument.
	const limit = record.arg as number
	const low = record.op === 'min' || record.op === 'length'
	const high = record.op === 'max' || record.op === 'length'
	if (out.type === 'string') {
		if (low) out.minLength = strongest(out.minLength, limit, Math.max)
		if (high) out.maxLength = strongest(out.maxLength, limit, Math.min)
	} else if (out.type === 'array') {
		if (low) out.minItems = strongest(out.minItems, limit, Math.max)
		if (high) out.maxItems = strongest(out.maxItems, limit, Math.min)
	} else {
		if (low) out.minimum = strongest(out.minimum, limit, Math.max)
		if (high) out.maximum = strongest(out.maximum, limit, Math.min)
	}
}

/** Repeated bounds all apply when parsing, so the schema keeps the strongest one. */
function strongest(
	current: number | undefined,
	limit: number,
	pick: (a: number, b: number) => number,
): number {
	return current === undefined ? limit : pick(current, limit)
}

function literalSchema(value: KLiteralValue): JsonSchema {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- A declared literal's JSON type follows its representation.
	switch (typeof value) {
		case 'string':
			return { type: 'string', const: value }
		case 'boolean':
			return { type: 'boolean', const: value }
		case 'bigint':
			return { type: 'integer', const: Number(value) }
		default:
			return { type: 'number', const: value }
	}
}

/** The JSON form of a declared default, or undefined when it has none (bigint, bytes). */
function jsonOf(value: Value): JSONValue | undefined {
	if (value === null) return null
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- A declared default is a Convex value whose JSON form follows its representation.
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return value
		case 'number':
			return Number.isFinite(value) ? value : undefined
		case 'bigint':
			return undefined
		default:
			break
	}
	if (value instanceof ArrayBuffer) return undefined
	if (Array.isArray(value)) {
		const items: JSONValue[] = []
		for (const item of value) {
			const json = jsonOf(item)
			if (json === undefined) return undefined
			items.push(json)
		}
		return items
	}
	const out: { [key: string]: JSONValue } = {}
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined) continue
		const json = jsonOf(item)
		if (json === undefined) return undefined
		out[key] = json
	}
	return out
}

function argNode(arg: KNode['arg']): KNode {
	// SAFETY: k.array stores its element schema as the root argument.
	return arg as KType
}

function defaultOf(record: KNode): Value {
	// SAFETY: a default record stores a Convex value as its argument.
	return record.arg as Value
}

function fieldsOf(root: KNode): KFields {
	// SAFETY: k.object stores its field map as the root argument.
	return root.arg as KFields
}

function literalOf(root: KNode): KLiteralValue {
	// SAFETY: k.literal stores its value as the root argument.
	return root.arg as KLiteralValue
}

function textOf(record: KNode): string {
	// SAFETY: a describe record stores its text as the record argument.
	return record.arg as string
}
