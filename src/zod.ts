/**
 * Zod interop (KTD7): `toZod()` as a function, and as a method that importing this entry installs on
 * every `k` schema. Schemas are built with `zod/mini`, so the entry bundles Zod's core and the few
 * constructors used here, not the classic method API: a result parses, checks and feeds any library
 * that accepts a Zod 4 schema, and is extended with `zod/mini` functions. Core declarations never mention Zod; the method's type comes from the global
 * `CvxKitSchemaMethods` augmentation below, so only apps that import `cvx-kit/zod` see it. (A module
 * augmentation of `./k/schema` would not resolve from the built `.d.mts` files.)
 */
import * as z from 'zod/mini'
import { membersOf } from './k/compile'
import { maxTimestamp } from './k/formats'
import { setOwn } from './k/names'
import { KSchema } from './k/schema'
import type { KDiscriminated, KFields, KLiteralValue, KMessage, KNode, KType } from './k/types'

/** The Zod Mini schema `toZod` produces: the `k` schema's output and input, except that transforms are not carried. */
export type KZod<S extends KType> = z.ZodMiniType<
	S['_t'] extends true ? S['validator']['type'] : S['_output'],
	S['validator']['type']
>

/** Metadata `toZod` records on every converted `k.id`: the table the id belongs to. */
export type KZodIdMeta = { tableName: string }

/**
 * The registry holding {@link KZodIdMeta} for converted ids: `kZodIds.get(schema)?.tableName` reads
 * which table an id schema belongs to. An id converts to a plain `z.string()` (it parses exactly as
 * `k.id` does), so libraries that convert Zod to Convex validators see a string, not an id.
 */
export const kZodIds = z.registry<KZodIdMeta>()

declare global {
	interface CvxKitSchemaMethods {
		/** Convert to Zod 4; see {@link toZod}. Installed by importing `cvx-kit/zod`. */
		toZod<S extends KType>(this: S): KZod<S>
	}
}

/**
 * Convert a `k` schema to a Zod 4 (`zod/mini`) schema, node by node. Ids keep their table typing in
 * {@link KZod} and record their table name in {@link kZodIds}. Carried: structure, strict objects (`strip()` objects strip), `min`, `max`,
 * `length`, `regex`, `int`, `trim`, case normalisers, defaults (as `prefault`, so a default runs through the chain like in `k`; a
 * `partial()` field drops its default), ISO date and date-time formats,
 * timestamps and `describe`. Not carried: `refine`, `check`, `overwrite`, `transform` and `pipe`; a
 * transformed schema converts to its input schema, and checks declared after a transform are dropped.
 * `k.jsonObject()` checks Convex's key rule on its top-level keys only; nested keys are not checked.
 * A schema holding `catch` throws.
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

function toZodMethod(this: KType): Mini {
	return convert(this)
}

type Mini = z.ZodMiniType

function convert(node: KNode): Mini {
	const records: KNode[] = []
	for (let current: KNode | null = node; current !== null; current = current.prev)
		records.push(current)
	// SAFETY: a chain always ends at a root record.
	const root = records.pop() as KNode
	let out = rootSchema(root, records.some(isStrip), records.some(isLoose))
	const partialAt = records.findIndex(isPartial)
	let transformed = false
	let description: string | undefined
	let run: KNode[] = []
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]
		if (isRunOp(record)) {
			if (!transformed) run.push(record)
			continue
		}
		if (record.op === 'describe') {
			description = textOf(record)
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
				out = z.optional(out)
				break
			case 'nullable':
				out = z.nullable(out)
				break
			case 'catch':
				// z.catch adds about 10 KB of zod/mini core to every bundle importing this entry.
				throw new Error(
					'toZod: .catch() is not carried; convert the wrapped schema and add z.catch yourself',
				)
			case 'default':
				if (!transformed && !(partialAt >= 0 && index > partialAt)) out = withDefault(out, record)
				break
			default:
				break
		}
	}
	out = applyRun(out, run)
	return description === undefined ? out : out.check(z.describe(description))
}

/** Convex's field-name rule (`isFieldName`): 1 to 1024 printable ASCII characters, the first not `$`. */
const fieldName = /^[ -#%-~][ -~]{0,1023}$/

function rootSchema(root: KNode, strip: boolean, loose: boolean): Mini {
	switch (root.op) {
		case 'string':
			return z.string()
		case 'isoDate':
			return z.iso.date()
		case 'isoDateTime':
			return z.iso.datetime({ offset: true })
		case 'id':
			// SAFETY: k.id stores its table name as the root argument.
			return z.string().register(kZodIds, { tableName: root.arg as string })
		case 'number':
			return z.number()
		case 'int':
			return z.int()
		case 'timestamp':
			return z.int().check(z.minimum(0), z.maximum(maxTimestamp))
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
		case 'jsonObject':
			// Top-level keys follow Convex's field-name rule; nested keys are not checked (see toZod).
			return z.record(z.string().check(z.regex(fieldName)), z.json())
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
			const converted: Record<string, Mini> = {}
			for (const key in fields) setOwn(converted, key, convert(fields[key]))
			if (loose) return z.looseObject(converted)
			return strip ? z.object(converted) : z.strictObject(converted)
		}
		case 'record': {
			// SAFETY: k.record stores its key and value schemas as the root argument.
			const [key, value] = root.arg as readonly KType[]
			// SAFETY: record keys are k.string() or k.id(), which convert to Zod record keys.
			return z.record(convert(key) as z.ZodMiniString, convert(value))
		}
		case 'union':
			return z.union(membersOf(root).map(convert))
		case 'discriminatedUnion': {
			// SAFETY: k.discriminatedUnion stores its key and object options as the root argument.
			const { key, options } = root.arg as KDiscriminated
			// SAFETY: each option is a k.object, which converts to a Zod object.
			const objects = options.map(convert) as [z.ZodMiniObject, ...z.ZodMiniObject[]]
			return z.discriminatedUnion(key, objects)
		}
		default:
			throw new Error(`toZod: '${root.op}' is not a root operation`)
	}
}

/** Apply one run of chained conveniences: normalisers first, then checks, as `k` parses them. */
function applyRun(base: Mini, run: readonly KNode[]): Mini {
	let out = base
	for (const record of run) if (isNormaliser(record)) out = applyNormaliser(out, record)
	for (const record of run) if (!isNormaliser(record)) out = applyCheck(out, record)
	return out
}

/** The Zod definition kind: a string format is a `string`, a number format a `number`. */
function kindOf(schema: Mini): string {
	return schema._zod.def.type
}

function applyNormaliser(base: Mini, record: KNode): Mini {
	if (kindOf(base) !== 'string') return base
	if (record.op === 'trim') return base.check(z.trim())
	if (record.op === 'lower') return base.check(z.toLowerCase())
	if (record.op === 'upper') return base.check(z.toUpperCase())
	return base
}

function applyCheck(base: Mini, record: KNode): Mini {
	const message = messageOf(record.message)
	const kind = kindOf(base)
	if (record.op === 'regex') {
		// SAFETY: .regex stores its pattern as the record argument.
		const pattern = record.arg as RegExp
		return kind === 'string' ? base.check(z.regex(pattern, message)) : base
	}
	if (record.op === 'int') return kind === 'number' ? base.check(z.int(message)) : base
	if (kind === 'number' && (record.op === 'gt' || record.op === 'lt')) {
		// SAFETY: gt and lt store their numeric limit as the record argument.
		const bound = record.arg as number
		return base.check(record.op === 'gt' ? z.gt(bound, message) : z.lt(bound, message))
	}
	if (kind === 'number' && record.op === 'safe')
		return base.check(
			z.int(message),
			z.minimum(Number.MIN_SAFE_INTEGER, message),
			z.maximum(Number.MAX_SAFE_INTEGER, message),
		)
	// `finite` needs no check: Zod's number already rejects NaN and the infinities.
	if (record.op !== 'min' && record.op !== 'max' && record.op !== 'length') return base
	// SAFETY: min, max and length store their numeric limit as the record argument.
	const limit = record.arg as number
	if (kind === 'string' || kind === 'array') {
		if (record.op === 'min') return base.check(z.minLength(limit, message))
		if (record.op === 'max') return base.check(z.maxLength(limit, message))
		return base.check(z.length(limit, message))
	}
	if (kind === 'number') {
		if (record.op === 'min') return base.check(z.minimum(limit, message))
		if (record.op === 'max') return base.check(z.maximum(limit, message))
	}
	return base
}

/**
 * `k` runs a default through the rest of the chain (normalisers, checks), so it maps to Zod's
 * `prefault`, not `default`, which would short-circuit.
 */
function withDefault(base: Mini, record: KNode): Mini {
	// SAFETY: a default record stores a value of the schema's input type here (no transform below it).
	return z.prefault(base, record.arg as never)
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
		case 'gt':
		case 'lt':
		case 'finite':
		case 'safe':
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

/** A `partial()` field is optional and never receives the default declared below it. */
function isPartial(record: KNode): boolean {
	return record.op === 'partial'
}

function isStrip(record: KNode): boolean {
	return record.op === 'strip'
}

function isLoose(record: KNode): boolean {
	return record.op === 'loose'
}

function textOf(record: KNode): string {
	// SAFETY: a describe record stores its text as the record argument.
	return record.arg as string
}
