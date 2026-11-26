/**
 * Zod interop (KTD7): `toZod()` as a function, and as a method that importing this entry installs on
 * every `k` schema. Core declarations never mention Zod; the method's type comes from the global
 * `CvxKitSchemaMethods` augmentation below, so only apps that import `cvx-kit/zod` see it. (A module
 * augmentation of `./k/schema` would not resolve from the built `.d.mts` files.)
 */
import { zid } from 'convex-helpers/server/zod4'
import { z } from 'zod'
import { membersOf } from './k/compile'
import { KSchema } from './k/schema'
import type { KDiscriminated, KFields, KLiteralValue, KMessage, KNode, KType } from './k/types'

/** The Zod schema `toZod` produces: the `k` schema's output and input, except that transforms are not carried. */
export type KZod<S extends KType> = z.ZodType<
	S['_t'] extends true ? S['validator']['type'] : S['_output'],
	S['validator']['type']
>

declare global {
	interface CvxKitSchemaMethods {
		/** Convert to Zod 4; see {@link toZod}. Installed by importing `cvx-kit/zod`. */
		toZod<S extends KType>(this: S): KZod<S>
	}
}

/**
 * Convert a `k` schema to a Zod 4 schema, node by node, with ids from convex-helpers' `zid` so they
 * keep their table typing. Carried: structure, strict objects (`strip()` objects strip), `min`, `max`,
 * `length`, `regex`, `int`, `trim`, case normalisers, defaults, ISO date and date-time formats,
 * timestamps and `describe`. Not carried: `refine`, `check`, `overwrite`, `transform` and `pipe`; a
 * transformed schema converts to its input schema, and checks declared after a transform are dropped.
 */
export function toZod<S extends KType>(schema: S): KZod<S> {
	// SAFETY: convert mirrors the schema's structure and declared checks node by node.
	return convert(schema) as KZod<S>
}

Object.defineProperty(KSchema.prototype, 'toZod', {
	value: toZodMethod,
	writable: true,
	configurable: true,
})

function toZodMethod(this: KType): z.ZodType {
	return convert(this)
}

function convert(node: KNode): z.ZodType {
	const records: KNode[] = []
	for (let current: KNode | null = node; current !== null; current = current.prev)
		records.push(current)
	// SAFETY: a chain always ends at a root record.
	const root = records.pop() as KNode
	let out = rootSchema(root, records.some(isStrip))
	let transformed = false
	let run: KNode[] = []
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]
		if (isRunOp(record)) {
			if (!transformed) run.push(record)
			continue
		}
		out = applyRun(out, run)
		run = []
		switch (record.op) {
			case 'transform':
			case 'pipe':
				transformed = true
				break
			case 'optional':
			case 'partial':
				out = out.optional()
				break
			case 'nullable':
				out = out.nullable()
				break
			case 'default':
				if (!transformed) out = withDefault(out, record)
				break
			case 'describe':
				out = out.describe(textOf(record))
				break
			default:
				break
		}
	}
	return applyRun(out, run)
}

function rootSchema(root: KNode, strip: boolean): z.ZodType {
	switch (root.op) {
		case 'string':
			return z.string()
		case 'isoDate':
			return z.iso.date()
		case 'isoDateTime':
			return z.iso.datetime({ offset: true })
		case 'id':
			// SAFETY: k.id stores its table name as the root argument.
			return zid(root.arg as string)
		case 'number':
			return z.number()
		case 'int':
			return z.number().int()
		case 'timestamp':
			return z.number().int().min(0)
		case 'int64':
			return z.bigint()
		case 'boolean':
			return z.boolean()
		case 'null':
			return z.null()
		case 'bytes':
			return z.instanceof(ArrayBuffer)
		case 'any':
			return z.any()
		case 'json':
			return z.json()
		case 'literal':
			// SAFETY: k.literal stores its value as the root argument.
			return z.literal(root.arg as KLiteralValue)
		case 'enum':
			// SAFETY: k.enum stores its non-empty value list as the root argument.
			return z.enum(root.arg as readonly [string, ...string[]])
		case 'array':
			// SAFETY: k.array stores its element schema as the root argument.
			return z.array(convert(root.arg as KType))
		case 'object': {
			// SAFETY: k.object stores its field map as the root argument.
			const fields = root.arg as KFields
			const converted: Record<string, z.ZodType> = {}
			for (const key in fields) converted[key] = convert(fields[key])
			return strip ? z.object(converted) : z.strictObject(converted)
		}
		case 'record': {
			// SAFETY: k.record stores its key and value schemas as the root argument.
			const [key, value] = root.arg as readonly KType[]
			// SAFETY: record keys are k.string() or k.id(), which convert to Zod record keys.
			return z.record(convert(key) as z.ZodString, convert(value))
		}
		case 'union':
			return z.union(membersOf(root).map(convert))
		case 'discriminatedUnion': {
			// SAFETY: k.discriminatedUnion stores its key and object options as the root argument.
			const { key, options } = root.arg as KDiscriminated
			// SAFETY: each option is a k.object, which converts to a Zod object.
			const objects = options.map(convert) as [z.ZodObject, ...z.ZodObject[]]
			return z.discriminatedUnion(key, objects)
		}
		default:
			throw new Error(`toZod: '${root.op}' is not a root operation`)
	}
}

/** Apply one run of chained conveniences: normalisers first, then checks, as `k` parses them. */
function applyRun(base: z.ZodType, run: readonly KNode[]): z.ZodType {
	let out = base
	for (const record of run) if (isNormaliser(record)) out = applyNormaliser(out, record)
	for (const record of run) if (!isNormaliser(record)) out = applyCheck(out, record)
	return out
}

function applyNormaliser(base: z.ZodType, record: KNode): z.ZodType {
	if (!(base instanceof z.ZodString || base instanceof z.ZodStringFormat)) return base
	if (record.op === 'trim') return base.trim()
	if (record.op === 'lower') return base.toLowerCase()
	if (record.op === 'upper') return base.toUpperCase()
	return base
}

function applyCheck(base: z.ZodType, record: KNode): z.ZodType {
	const message = messageOf(record.message)
	if (record.op === 'regex') {
		// SAFETY: .regex stores its pattern as the record argument.
		const pattern = record.arg as RegExp
		return base instanceof z.ZodString || base instanceof z.ZodStringFormat
			? base.regex(pattern, message)
			: base
	}
	if (record.op === 'int') return base instanceof z.ZodNumber ? base.int(message) : base
	if (record.op !== 'min' && record.op !== 'max' && record.op !== 'length') return base
	// SAFETY: min, max and length store their numeric limit as the record argument.
	const limit = record.arg as number
	if (
		base instanceof z.ZodString ||
		base instanceof z.ZodStringFormat ||
		base instanceof z.ZodArray
	) {
		if (record.op === 'min') return base.min(limit, message)
		if (record.op === 'max') return base.max(limit, message)
		return base.length(limit, message)
	}
	if (base instanceof z.ZodNumber) {
		if (record.op === 'min') return base.min(limit, message)
		if (record.op === 'max') return base.max(limit, message)
	}
	return base
}

function withDefault(base: z.ZodType, record: KNode): z.ZodType {
	// SAFETY: a default record stores a value of the schema's output type.
	return base.default(record.arg as never)
}

function messageOf(message: KMessage): string | undefined {
	if (message === undefined) return undefined
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- refine stores either its message or its options object.
	return typeof message === 'string' ? message : message.message
}

function isRunOp(record: KNode): boolean {
	switch (record.op) {
		case 'min':
		case 'max':
		case 'length':
		case 'regex':
		case 'int':
		case 'trim':
		case 'lower':
		case 'upper':
		case 'refine':
		case 'check':
		case 'overwrite':
			return true
		default:
			return false
	}
}

function isNormaliser(record: KNode): boolean {
	return record.op === 'trim' || record.op === 'lower' || record.op === 'upper'
}

function isStrip(record: KNode): boolean {
	return record.op === 'strip'
}

function textOf(record: KNode): string {
	// SAFETY: a describe record stores its text as the record argument.
	return record.arg as string
}
