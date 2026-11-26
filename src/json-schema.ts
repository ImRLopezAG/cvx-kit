/** JSON Schema for `k` schemas (KTD8): a separate entry, so core function bundles never load it. */
import type { JSONValue, Value } from 'convex/values'
import { membersOf } from './k/compile'
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
	minItems?: number
	maxItems?: number
	items?: JsonSchema
	properties?: Record<string, JsonSchema>
	required?: string[]
	additionalProperties?: boolean | JsonSchema
	propertyNames?: JsonSchema
	anyOf?: JsonSchema[]
	oneOf?: JsonSchema[]
}

export type JsonSchemaOptions = {
	/** Add `$schema: "https://json-schema.org/draft/2020-12/schema"` to the root. */
	readonly $schema?: boolean
}

/**
 * The input-side JSON Schema of a `k` schema, for agent tool inputs and forms: optional and defaulted
 * fields are not required (a JSON-compatible default is emitted), ids are strings, transforms and pipes
 * emit their input schema, and descriptions come from `.describe()`. Custom refinements are not
 * expressible and are omitted.
 */
export function toJsonSchema(schema: KType, options?: JsonSchemaOptions): JsonSchema {
	const out = convert(schema)
	if (options?.$schema === true)
		return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...out }
	return out
}

function convert(node: KNode): JsonSchema {
	const records: KNode[] = []
	for (let current: KNode | null = node; current !== null; current = current.prev)
		records.push(current)
	// SAFETY: a chain always ends at a root record.
	const out = rootSchema(records.pop() as KNode)
	let transformed = false
	let nullable = false
	let description: string | undefined
	let fallback: JSONValue | undefined
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]
		switch (record.op) {
			case 'transform':
			case 'pipe':
				transformed = true
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

function rootSchema(root: KNode): JsonSchema {
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
			return { type: 'integer', minimum: 0 }
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
			return { type: 'array', items: convert(argNode(root.arg)) }
		case 'object':
			return objectSchema(fieldsOf(root))
		case 'record': {
			// SAFETY: k.record stores its key and value schemas as the root argument.
			const [key, value] = root.arg as readonly KType[]
			return { type: 'object', propertyNames: convert(key), additionalProperties: convert(value) }
		}
		case 'union':
			return { anyOf: membersOf(root).map(convert) }
		case 'discriminatedUnion': {
			// SAFETY: k.discriminatedUnion stores its key and options as the root argument.
			const { options } = root.arg as KDiscriminated
			return { oneOf: options.map(convert) }
		}
		default:
			throw new Error(`toJsonSchema: '${root.op}' is not a root operation`)
	}
}

function objectSchema(fields: KFields): JsonSchema {
	const properties: Record<string, JsonSchema> = {}
	const required: string[] = []
	for (const key in fields) {
		properties[key] = convert(fields[key])
		if (isRequired(fields[key])) required.push(key)
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

function applyCheck(out: JsonSchema, record: KNode): void {
	if (record.op === 'int') {
		out.type = 'integer'
		return
	}
	if (record.op === 'regex') {
		// SAFETY: .regex stores its pattern as the record argument.
		out.pattern = (record.arg as RegExp).source
		return
	}
	// SAFETY: min, max and length store their numeric limit as the record argument.
	const limit = record.arg as number
	const low = record.op === 'min' || record.op === 'length'
	const high = record.op === 'max' || record.op === 'length'
	if (out.type === 'string') {
		if (low) out.minLength = limit
		if (high) out.maxLength = limit
	} else if (out.type === 'array') {
		if (low) out.minItems = limit
		if (high) out.maxItems = limit
	} else {
		if (low) out.minimum = limit
		if (high) out.maximum = limit
	}
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
