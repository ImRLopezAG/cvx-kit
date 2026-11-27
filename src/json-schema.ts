/** JSON Schema for `k` schemas (KTD8): a separate entry, so core function bundles never load it. */
import type { StandardJSONSchemaV1 } from '@standard-schema/spec'
import type { JSONValue, Value } from 'convex/values'
import { membersOf } from './k/compile'
import { maxTimestamp } from './k/formats'
import { setOwn } from './k/names'
import { installJsonSchemaConverter } from './k/standard'
import type { KDiscriminated, KFields, KLiteralValue, KNode, KType } from './k/types'

/** The JSON Schema (draft 2020-12) subset `toJsonSchema` emits. */
export type JsonSchema = {
	$schema?: string
	$ref?: string
	$defs?: Record<string, JsonSchema>
	definitions?: Record<string, JsonSchema>
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
	/**
	 * Emit a sub-schema that occurs more than once (the same object, array, record or union schema
	 * instance, by identity) once under `$defs` and reference it with `$ref`. Off by default, so the
	 * inline output stays as before; turn it on for large contracts that repeat a filter or DTO schema.
	 */
	readonly refs?: boolean
}

/** The JSON Schema dialects `~standard.jsonSchema` produces; others throw, as the spec asks. */
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema'
const DRAFT_07 = 'http://json-schema.org/draft-07/schema#'

declare global {
	interface CvxKitStandardProps {
		/**
		 * Standard JSON Schema v1 (`@standard-schema/spec`): `input` and `output` JSON Schema for
		 * `draft-2020-12` and `draft-07`. Installed by importing `cvx-kit/json-schema`.
		 */
		readonly jsonSchema: StandardJSONSchemaV1.Converter
	}
}

/** Repeated sub-schemas of the conversion in progress, when `refs` is on. */
let shared: { names: Map<KNode, string>; defs: Record<string, JsonSchema> } | null = null

/**
 * Above zero while converting the output side below a `.catch`: the fallback is not validated, so only
 * the type-level shape is promised (no length, range, pattern or format checks).
 */
let unchecked = 0

/**
 * The input-side JSON Schema of a `k` schema, for agent tool inputs and forms: optional and defaulted
 * fields are not required (a JSON-compatible default is emitted), ids are strings, transforms and pipes
 * emit their input schema, and descriptions come from `.describe()`. Custom refinements are not
 * expressible and are omitted.
 */
export function toJsonSchema(schema: KType, options?: JsonSchemaOptions): JsonSchema {
	return document(schema, options, DRAFT_2020_12, '$defs')
}

installJsonSchemaConverter((schema) => ({
	input: (options) => standardDocument(schema, options, 'input'),
	output: (options) => standardDocument(schema, options, 'output'),
}))

function standardDocument(
	schema: KNode,
	options: StandardJSONSchemaV1.Options,
	io: 'input' | 'output',
): JsonSchema {
	const draft07 = options.target === 'draft-07'
	if (!draft07 && options.target !== 'draft-2020-12')
		throw new Error(
			`cvx-kit: JSON Schema target '${options.target}' is not supported; use 'draft-2020-12' or 'draft-07'`,
		)
	const refs = options.libraryOptions?.refs === true
	return document(
		schema,
		{ $schema: true, io, refs },
		draft07 ? DRAFT_07 : DRAFT_2020_12,
		draft07 ? 'definitions' : '$defs',
	)
}

function document(
	schema: KNode,
	options: JsonSchemaOptions | undefined,
	dialect: string,
	defsKey: '$defs' | 'definitions',
): JsonSchema {
	const output = options?.io === 'output'
	const previous = shared
	shared = options?.refs === true ? { names: repeated(schema, output, defsKey), defs: {} } : null
	try {
		const out = convert(schema, output)
		const head: JsonSchema = options?.$schema === true ? { $schema: dialect } : {}
		const defs = shared?.defs
		return defs !== undefined && Object.keys(defs).length > 0
			? { ...head, ...out, [defsKey]: defs }
			: { ...head, ...out }
	} finally {
		shared = previous
	}
}

/** Container sub-schemas met more than once in the tree, by identity, each with its `$ref` target. */
function repeated(schema: KNode, output: boolean, defsKey: string): Map<KNode, string> {
	const seen = new Map<KNode, number>()
	const visit = (node: KNode) => {
		let root = node
		for (; root.prev !== null; root = root.prev)
			if (output && root.op === 'pipe') visit(argNode(root.arg))
		const container = CONTAINERS.has(root.op)
		if (container) {
			const count = (seen.get(node) ?? 0) + 1
			seen.set(node, count)
			if (count > 1) return
		}
		for (const child of childrenOf(root)) visit(child)
	}
	visit(schema)
	const names = new Map<KNode, string>()
	for (const [node, count] of seen)
		if (count > 1 && node !== schema) names.set(node, `#/${defsKey}/s${names.size}`)
	return names
}

/**
 * Convex's field-name rule (`isFieldName`) as a regex: 1 to 1024 printable ASCII characters, the
 * first not `$`.
 */
const FIELD_NAME_PATTERN = '^[ -#%-~][ -~]{0,1023}$'

const CONTAINERS = new Set(['object', 'array', 'record', 'union', 'discriminatedUnion'])

function childrenOf(root: KNode): readonly KNode[] {
	switch (root.op) {
		case 'array':
			return [argNode(root.arg)]
		case 'object':
			return Object.values(fieldsOf(root))
		case 'record':
			// SAFETY: k.record stores its key and value schemas as the root argument.
			return root.arg as readonly KType[]
		case 'union':
		case 'discriminatedUnion':
			return membersOf(root)
		default:
			return []
	}
}

function convert(node: KNode, output: boolean): JsonSchema {
	const ref = shared?.names.get(node)
	if (ref === undefined || shared === null) return convertNode(node, output)
	const name = ref.slice(ref.lastIndexOf('/') + 1)
	if (!(name in shared.defs)) {
		const defs = shared.defs
		// Reserve the name first so a nested repeat of a different schema numbers after it.
		defs[name] = {}
		defs[name] = convertNode(node, output)
	}
	return { $ref: ref }
}

function convertNode(node: KNode, output: boolean): JsonSchema {
	const records: KNode[] = []
	for (let current: KNode | null = node; current !== null; current = current.prev)
		records.push(current)
	// SAFETY: a chain always ends at a root record.
	let out = rootSchema(records.pop() as KNode, output)
	let transformed = false
	let nullable = false
	let description: string | undefined
	let fallback: JSONValue | undefined
	// Checks after a normaliser test the normalised value, so the input side keeps only those the raw
	// value must also meet: after `trim`, a lower length bound; after any other normaliser, none.
	let normalised: 'none' | 'trim' | 'other' = 'none'
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]
		switch (record.op) {
			case 'transform':
				if (output) {
					out = {}
					nullable = false
					fallback = undefined
				}
				transformed = true
				break
			case 'pipe':
				// The output is the target's: wrappers and defaults declared before the pipe no longer apply.
				if (output) {
					out = convert(argNode(record.arg), true)
					nullable = false
					fallback = undefined
				}
				transformed = true
				break
			case 'catch':
				// A fallback accepts any input. On the output side it is not validated, so the wrapped
				// schema's shape is emitted without its checks.
				transformed = true
				if (!output) out = {}
				else {
					out = uncheckedOutput(prevOf(record))
					nullable = false
					fallback = undefined
				}
				break
			case 'describe':
				description = textOf(record)
				break
			case 'loose':
				out = { ...out, additionalProperties: true }
				break
			case 'strip':
				// A stripping object accepts unknown keys, so its input side does not forbid them; its output has none.
				out = output ? { ...out, additionalProperties: false } : withoutAdditional(out)
				break
			case 'strict':
				out = { ...out, additionalProperties: false }
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
				if (!transformed && unchecked === 0 && rawHolds(record, output ? 'none' : normalised))
					applyCheck(out, record)
				break
			case 'trim':
				if (normalised === 'none') normalised = 'trim'
				break
			case 'lower':
			case 'upper':
			case 'overwrite':
				normalised = 'other'
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

/** The output-side shape of the schema below a `.catch`, with no checks and no shared `$ref`s. */
function uncheckedOutput(node: KNode): JsonSchema {
	const previous = shared
	shared = null
	unchecked++
	try {
		return convertNode(node, true)
	} finally {
		unchecked--
		shared = previous
	}
}

function rawHolds(record: KNode, normalised: 'none' | 'trim' | 'other'): boolean {
	if (normalised === 'none') return true
	return normalised === 'trim' && record.op === 'min'
}

function rootSchema(root: KNode, output: boolean): JsonSchema {
	if (unchecked > 0)
		switch (root.op) {
			case 'isoDate':
			case 'isoDateTime':
				return { type: 'string' }
			case 'timestamp':
				return { type: 'integer' }
			default:
				break
		}
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
		case 'jsonObject':
			// Top-level keys follow Convex's field-name rule exactly; nested keys are checked by parse
			// only, since a recursive `$ref` form suits fewer tool-calling consumers.
			return { type: 'object', propertyNames: { type: 'string', pattern: FIELD_NAME_PATTERN } }
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

function withoutAdditional(schema: JsonSchema): JsonSchema {
	const { additionalProperties, ...rest } = schema
	void additionalProperties
	return rest
}

function objectSchema(fields: KFields, output: boolean): JsonSchema {
	const properties: Record<string, JsonSchema> = {}
	const required: string[] = []
	for (const key in fields) {
		setOwn(properties, key, convert(fields[key], output))
		if (output ? isRequiredOutput(fields[key]) : isRequired(fields[key])) required.push(key)
	}
	const out: JsonSchema = { type: 'object', properties, additionalProperties: false }
	if (required.length > 0) out.required = required
	return out
}

function isRequired(node: KNode): boolean {
	for (let current: KNode | null = node; current !== null; current = current.prev) {
		// A caught field parses to its fallback when absent.
		if (
			current.op === 'optional' ||
			current.op === 'partial' ||
			current.op === 'default' ||
			current.op === 'catch'
		)
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
				return true
			case 'pipe':
				// Absent input reaches the target: present if the target fills it or rejects it.
				return isRequiredOutput(argNode(current.arg)) || isRequiredOutput(prevOf(current))
			default:
				// A transform does not prove presence: an optional input stays optional through it.
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
		setOwn(out, key, json)
	}
	return out
}

function argNode(arg: KNode['arg']): KNode {
	// SAFETY: k.array stores its element schema as the root argument.
	return arg as KType
}

function prevOf(record: KNode): KNode {
	// SAFETY: only chain records, which always have a predecessor, are passed here.
	return record.prev as KNode
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
