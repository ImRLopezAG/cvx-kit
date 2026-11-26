/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- This module is the decoding boundary: it receives undecoded values, narrows them by representation and hands them back as the schema's output, which the typed callers in schema.ts name. */
import { membersOf } from './compile'
import { KConversionFailure, isIsoDate, isIsoDateTime, isTimestamp, maxTimestamp } from './formats'
import {
	KValidationError,
	type KIssue,
	type KIssueCode,
	type KIssueInput,
	type KSafeParseResult,
} from './issues'
import type { KCheckContext } from './schema'
import type {
	KDiscriminated,
	KFields,
	KLiteralValue,
	KNode,
	KPath,
	KRefineOptions,
	KType,
} from './types'

/**
 * The memoised parse plan of one chain record. `declared` says whether the subtree declares any
 * behaviour a structurally valid value still needs (default, normaliser, check, transform, integer or
 * JSON check); `transform` whether it holds a transform or pipe. A record at the tip of a run of checks
 * and normalisers also records the run: the record below it and the run's normalisers and checks in
 * declared order. A discriminated union root records its dispatch table.
 */
export class KPlan {
	readonly declared: boolean
	readonly transform: boolean
	readonly base: KNode | null
	readonly normalisers: readonly KNode[]
	readonly checks: readonly KNode[]
	readonly dispatch: ReadonlyMap<KLiteralValue, KNode> | null

	constructor(
		declared: boolean,
		transform: boolean,
		base: KNode | null,
		normalisers: readonly KNode[],
		checks: readonly KNode[],
		dispatch: ReadonlyMap<KLiteralValue, KNode> | null,
	) {
		this.declared = declared
		this.transform = transform
		this.base = base
		this.normalisers = normalisers
		this.checks = checks
		this.dispatch = dispatch
	}
}

export function parseSchema(schema: KNode, input: unknown): unknown {
	const context = new WalkContext()
	const output = walk(schema, input, context, true, false)
	if (context.issues.length > 0) throw new KValidationError(context.issues)
	return output
}

export function safeParseSchema(schema: KNode, input: unknown): KSafeParseResult<unknown> {
	const context = new WalkContext()
	const output = walk(schema, input, context, true, false)
	if (context.issues.length > 0) return { success: false, issues: context.issues }
	return { success: true, data: output }
}

/**
 * The function-boundary entry (KTD3): `value` has already passed the schema's native validator, so only
 * planned paths are visited. With an empty plan the very same value is returned without a walk.
 */
export function runDeclared(schema: KNode, value: unknown): unknown {
	if (!planOf(schema).declared) return value
	const context = new WalkContext()
	const output = walk(schema, value, context, false, false)
	if (context.issues.length > 0) throw new KValidationError(context.issues)
	return output
}

export function hasDeclaredBehaviour(schema: KNode): boolean {
	return planOf(schema).declared
}

/** Whether a transform or pipe sits anywhere in the schema's tree; table fields and return shapes reject it. */
export function containsTransform(schema: KNode): boolean {
	return planOf(schema).transform
}

const FAIL: unique symbol = Symbol('k.fail')
const noRecords: readonly KNode[] = []
const emptyPlan = new KPlan(false, false, null, noRecords, noRecords, null)
const checkedPlan = new KPlan(true, false, null, noRecords, noRecords, null)
const transformPlan = new KPlan(true, true, null, noRecords, noRecords, null)

class WalkContext {
	issues: KIssue[] = []
	readonly path: KPath = []

	add(code: KIssueCode, message: string, below: KPath | undefined): void {
		const path = below === undefined ? [...this.path] : [...this.path, ...below]
		this.issues.push({ path, code, message })
	}
}

class CheckContext implements KCheckContext {
	readonly context: WalkContext

	constructor(context: WalkContext) {
		this.context = context
	}

	addIssue(issue: KIssueInput): void {
		this.context.add(issue.code ?? 'custom', issue.message, issue.path)
	}
}

function planOf(node: KNode): KPlan {
	return (node.plan ??= compilePlan(node))
}

function compilePlan(node: KNode): KPlan {
	if (node.prev === null) return rootPlan(node)
	switch (node.op) {
		case 'optional':
		case 'partial':
		case 'nullable':
		case 'strip':
		case 'describe':
			return planOf(node.prev)
		case 'default':
			return planOf(node.prev).transform ? transformPlan : checkedPlan
		case 'transform':
		case 'pipe':
			return transformPlan
		default:
			return runPlan(node)
	}
}

function runPlan(node: KNode): KPlan {
	const run: KNode[] = []
	let base = node
	while (base.prev !== null && (isRunOp(base) || base.op === 'describe')) {
		if (base.op !== 'describe') run.push(base)
		base = base.prev
	}
	const normalisers: KNode[] = []
	const checks: KNode[] = []
	for (let index = run.length - 1; index >= 0; index--) {
		const record = run[index]
		if (isNormaliser(record)) normalisers.push(record)
		else checks.push(record)
	}
	return new KPlan(true, planOf(base).transform, base, normalisers, checks, null)
}

function rootPlan(root: KNode): KPlan {
	switch (root.op) {
		case 'int':
		case 'json':
		case 'isoDate':
		case 'isoDateTime':
		case 'timestamp':
			return checkedPlan
		case 'array':
			return planOf(argSchema(root))
		case 'object': {
			const fields = fieldsOf(root)
			let declared = false
			let transform = false
			for (const key in fields) {
				const plan = planOf(asSchema(fields[key]))
				declared ||= plan.declared
				transform ||= plan.transform
			}
			return combined(declared, transform)
		}
		case 'record': {
			const [key, value] = recordOf(root)
			const keyPlan = planOf(key)
			const valuePlan = planOf(value)
			return combined(
				keyPlan.declared || valuePlan.declared,
				keyPlan.transform || valuePlan.transform,
			)
		}
		case 'union':
		case 'discriminatedUnion': {
			let declared = false
			let transform = false
			for (const member of membersOf(root)) {
				const plan = planOf(member)
				declared ||= plan.declared
				transform ||= plan.transform
			}
			if (root.op === 'union') return combined(declared, transform)
			return new KPlan(declared, transform, null, noRecords, noRecords, dispatchOf(root))
		}
		default:
			return emptyPlan
	}
}

function combined(declared: boolean, transform: boolean): KPlan {
	if (transform) return transformPlan
	return declared ? checkedPlan : emptyPlan
}

function dispatchOf(root: KNode): Map<KLiteralValue, KNode> {
	// SAFETY: k.discriminatedUnion stores its key and object options as the root argument.
	const { key, options } = root.arg as KDiscriminated
	const dispatch = new Map<KLiteralValue, KNode>()
	for (const option of options) {
		const member = asSchema(option)
		const field = fieldsOf(rootOf(member))[key]
		if (field === undefined)
			throw new Error(`k.discriminatedUnion: an option has no '${key}' field`)
		const fieldRoot = rootOf(asSchema(field))
		if (fieldRoot.op === 'literal') dispatchTo(dispatch, key, literalOf(fieldRoot), member)
		else if (fieldRoot.op === 'enum')
			for (const value of enumOf(fieldRoot)) dispatchTo(dispatch, key, value, member)
		else throw new Error(`k.discriminatedUnion: '${key}' must be a literal or enum on every option`)
	}
	return dispatch
}

/** Two options sharing a discriminator value would make dispatch pick a branch the native union may not. */
function dispatchTo(
	dispatch: Map<KLiteralValue, KNode>,
	key: string,
	value: KLiteralValue,
	member: KNode,
): void {
	if (dispatch.has(value))
		throw new Error(
			`k.discriminatedUnion: more than one option has '${key}' value ${JSON.stringify(String(value))}`,
		)
	dispatch.set(value, member)
}

function walk(
	node: KNode,
	value: unknown,
	context: WalkContext,
	full: boolean,
	strip: boolean,
): unknown {
	if (!full && !planOf(node).declared) return value
	if (node.prev === null) return walkRoot(node, value, context, full, strip)
	switch (node.op) {
		case 'optional':
			if (value === undefined && !defaultsBelow(node.prev)) return undefined
			return walk(node.prev, value, context, full, strip)
		case 'partial':
			return value === undefined ? undefined : walk(node.prev, value, context, full, strip)
		case 'describe':
			return walk(node.prev, value, context, full, strip)
		case 'nullable':
			return value === null ? null : walk(node.prev, value, context, full, strip)
		case 'default':
			if (value !== undefined) return walk(node.prev, value, context, full, strip)
			if (planOf(node.prev).transform) return node.arg
			return walk(node.prev, node.arg, context, full, strip)
		case 'strip':
			return walk(node.prev, value, context, full, true)
		case 'transform': {
			const input = walk(node.prev, value, context, full, strip)
			return input === FAIL ? FAIL : callbackResult(callbackOf(node)(input), context, 'transform')
		}
		case 'pipe': {
			const input = walk(node.prev, value, context, full, strip)
			return input === FAIL ? FAIL : walk(argSchema(node), input, context, true, false)
		}
		default:
			return walkRun(node, value, context, full, strip)
	}
}

function walkRun(
	node: KNode,
	value: unknown,
	context: WalkContext,
	full: boolean,
	strip: boolean,
): unknown {
	const plan = planOf(node)
	// SAFETY: runPlan always records the base below a run.
	let output = walk(plan.base as KNode, value, context, full, strip)
	if (output === FAIL) return FAIL
	for (const normaliser of plan.normalisers) {
		output = callbackResult(normalise(normaliser, output), context, 'overwrite')
		if (output === FAIL) return FAIL
	}
	const before = context.issues.length
	for (const check of plan.checks) runCheck(check, output, context)
	return context.issues.length === before ? output : FAIL
}

function normalise(record: KNode, value: unknown): unknown {
	switch (record.op) {
		case 'trim':
			return stringOf(value).trim()
		case 'lower':
			return stringOf(value).toLowerCase()
		case 'upper':
			return stringOf(value).toUpperCase()
		default:
			return callbackOf(record)(value)
	}
}

function runCheck(record: KNode, value: unknown, context: WalkContext): void {
	switch (record.op) {
		case 'min': {
			const limit = numberArg(record)
			if (!(sizeOf(value) >= limit))
				context.add(
					'too_small',
					messageOf(record, `Too small: expected ${unitOf(value, limit, '>=')}`),
					undefined,
				)
			return
		}
		case 'max': {
			const limit = numberArg(record)
			if (!(sizeOf(value) <= limit))
				context.add(
					'too_big',
					messageOf(record, `Too big: expected ${unitOf(value, limit, '<=')}`),
					undefined,
				)
			return
		}
		case 'length': {
			const limit = numberArg(record)
			const size = sizeOf(value)
			if (size === limit) return
			if (!(size > limit))
				context.add(
					'too_small',
					messageOf(record, `Too small: expected ${unitOf(value, limit, '==')}`),
					undefined,
				)
			else
				context.add(
					'too_big',
					messageOf(record, `Too big: expected ${unitOf(value, limit, '==')}`),
					undefined,
				)
			return
		}
		case 'regex': {
			// SAFETY: .regex stores its pattern as the record argument.
			const pattern = record.arg as RegExp
			pattern.lastIndex = 0
			if (!pattern.test(stringOf(value)))
				context.add(
					'invalid_format',
					messageOf(record, `Invalid string: must match ${pattern}`),
					undefined,
				)
			return
		}
		case 'int':
			if (!Number.isInteger(value))
				context.add('not_integer', messageOf(record, 'Expected an integer'), undefined)
			return
		case 'refine':
			if (settled(callbackOf(record)(value)) !== true) {
				const options = optionsOf(record)
				context.add('custom', options?.message ?? 'Invalid input', options?.path)
			}
			return
		case 'check': {
			const result = callbackOf(record)(value, new CheckContext(context))
			if (isThenable(settled(result)))
				context.add('custom', 'A check must be synchronous', undefined)
			return
		}
		default:
			throw new Error(`k: '${record.op}' is not a check`)
	}
}

function walkRoot(
	root: KNode,
	value: unknown,
	context: WalkContext,
	full: boolean,
	strip: boolean,
): unknown {
	switch (root.op) {
		case 'array':
			if (full && !Array.isArray(value)) return invalidType(context, 'array', value)
			// SAFETY: checked above, or already validated natively at a function boundary.
			return walkArray(root, value as unknown[], context, full)
		case 'object':
			if (full && !isPlainObject(value)) {
				if (strip && isInstance(value))
					return walkObject(root, ownSnapshot(value), context, full, strip)
				return invalidType(context, 'object', value)
			}
			// SAFETY: checked above, or already validated natively at a function boundary.
			return walkObject(root, value as Record<string, unknown>, context, full, strip)
		case 'record':
			if (full && !isPlainObject(value)) return invalidType(context, 'record', value)
			// SAFETY: checked above, or already validated natively at a function boundary.
			return walkRecord(root, value as Record<string, unknown>, context, full)
		case 'union':
			return walkUnion(root, value, context)
		case 'discriminatedUnion':
			if (full && !isPlainObject(value)) return invalidType(context, 'object', value)
			// SAFETY: checked above, or already validated natively at a function boundary.
			return walkDiscriminated(root, value as Record<string, unknown>, context, full)
		case 'int':
			if (full && typeof value !== 'number') return invalidType(context, 'number', value)
			if (Number.isInteger(value)) return value
			context.add('not_integer', 'Expected an integer', undefined)
			return FAIL
		case 'isoDate':
			if (full && typeof value !== 'string') return invalidType(context, 'string', value)
			if (isIsoDate(stringOf(value))) return value
			context.add('invalid_format', 'Invalid ISO date: expected YYYY-MM-DD', undefined)
			return FAIL
		case 'isoDateTime':
			if (full && typeof value !== 'string') return invalidType(context, 'string', value)
			if (isIsoDateTime(stringOf(value))) return value
			context.add('invalid_format', 'Invalid ISO date-time', undefined)
			return FAIL
		case 'timestamp':
			return walkTimestamp(value, context, full)
		case 'json':
			if (isJson(value)) return value
			context.add('invalid_type', 'Expected a JSON value', undefined)
			return FAIL
		default:
			return full ? walkLeaf(root, value, context) : value
	}
}

function walkTimestamp(value: unknown, context: WalkContext, full: boolean): unknown {
	if (full && typeof value !== 'number') return invalidType(context, 'number', value)
	// SAFETY: checked above, or already validated natively at a function boundary.
	const time = value as number
	if (isTimestamp(time)) return value
	if (!Number.isFinite(time)) context.add('invalid_type', 'Expected a finite timestamp', undefined)
	else if (!Number.isInteger(time))
		context.add('not_integer', 'Expected integer milliseconds', undefined)
	else if (time < 0) context.add('too_small', 'Expected a timestamp >= 0', undefined)
	else
		context.add(
			'too_big',
			`Expected a timestamp <= ${maxTimestamp} (9999-12-31T23:59:59.999Z)`,
			undefined,
		)
	return FAIL
}

function walkLeaf(root: KNode, value: unknown, context: WalkContext): unknown {
	switch (root.op) {
		case 'string':
		case 'id':
			return typeof value === 'string' ? value : invalidType(context, 'string', value)
		case 'number':
			return typeof value === 'number' ? value : invalidType(context, 'number', value)
		case 'int64':
			return typeof value === 'bigint' ? value : invalidType(context, 'bigint', value)
		case 'boolean':
			return typeof value === 'boolean' ? value : invalidType(context, 'boolean', value)
		case 'null':
			return value === null ? value : invalidType(context, 'null', value)
		case 'bytes':
			return value instanceof ArrayBuffer ? value : invalidType(context, 'ArrayBuffer', value)
		case 'any':
			return value === undefined ? invalidType(context, 'a value', value) : value
		case 'literal': {
			const expected = literalOf(root)
			if (value === expected) return value
			context.add(
				'invalid_value',
				`Invalid input: expected ${JSON.stringify(String(expected))}`,
				undefined,
			)
			return FAIL
		}
		case 'enum': {
			const values = enumOf(root)
			if (typeof value === 'string' && values.includes(value)) return value
			context.add(
				'invalid_value',
				`Invalid option: expected one of ${values.map(quoted).join('|')}`,
				undefined,
			)
			return FAIL
		}
		default:
			throw new Error(`k: '${root.op}' is not a root operation`)
	}
}

function walkArray(root: KNode, value: unknown[], context: WalkContext, full: boolean): unknown {
	const element = argSchema(root)
	let out: unknown[] | undefined
	let failed = false
	for (let index = 0; index < value.length; index++) {
		const input = value[index]
		context.path.push(index)
		const output = walk(element, input, context, full, false)
		context.path.pop()
		if (output === FAIL) failed = true
		else {
			if (out === undefined && output !== input) out = value.slice(0, index)
			out?.push(output)
		}
	}
	if (failed) return FAIL
	return out ?? value
}

function walkObject(
	root: KNode,
	value: Record<string, unknown>,
	context: WalkContext,
	full: boolean,
	strip: boolean,
): unknown {
	const fields = fieldsOf(root)
	let out: Record<string, unknown> | undefined
	let failed = false
	for (const key in fields) {
		const input = Object.hasOwn(value, key) ? value[key] : undefined
		context.path.push(key)
		const output = walk(asSchema(fields[key]), input, context, full, false)
		context.path.pop()
		if (output === FAIL) {
			failed = true
			continue
		}
		if (out === undefined && output !== input) {
			out = {}
			copyKnown(out, value, fields, key)
		}
		if (out !== undefined && output !== undefined) setOwn(out, key, output)
	}
	let stripped = false
	if (full) {
		for (const key of Object.keys(value)) {
			if (Object.hasOwn(fields, key)) continue
			if (strip) stripped = true
			else {
				failed = true
				context.add('unrecognized_key', `Unrecognized key: ${JSON.stringify(key)}`, [key])
			}
		}
	}
	if (failed) return FAIL
	if (stripped && out === undefined) {
		out = {}
		copyKnown(out, value, fields, null)
	}
	return out ?? value
}

/** Copy into `out` the known fields of `value` before `stop` in declaration order (all of them for `null`). */
function copyKnown(
	out: Record<string, unknown>,
	value: Record<string, unknown>,
	fields: KFields,
	stop: string | null,
): void {
	for (const key in fields) {
		if (key === stop) break
		if (Object.hasOwn(value, key) && value[key] !== undefined) setOwn(out, key, value[key])
	}
}

function walkRecord(
	root: KNode,
	value: Record<string, unknown>,
	context: WalkContext,
	full: boolean,
): unknown {
	const [keySchema, valueSchema] = recordOf(root)
	const keys = Object.keys(value)
	let out: Record<string, unknown> | undefined
	let failed = false
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index]
		const input = value[key]
		context.path.push(key)
		let outputKey = walk(keySchema, key, context, full, false)
		if (outputKey !== FAIL && (full || outputKey !== key) && !isRecordKey(stringOf(outputKey))) {
			context.add('invalid_format', recordKeyMessage, undefined)
			outputKey = FAIL
		}
		const output = walk(valueSchema, input, context, full, false)
		context.path.pop()
		if (outputKey === FAIL || output === FAIL) {
			failed = true
			continue
		}
		if (out === undefined && (outputKey !== key || output !== input)) {
			out = {}
			for (let before = 0; before < index; before++) setOwn(out, keys[before], value[keys[before]])
		}
		if (out !== undefined) setOwn(out, stringOf(outputKey), output)
	}
	if (failed) return FAIL
	return out ?? value
}

function walkUnion(root: KNode, value: unknown, context: WalkContext): unknown {
	const issues = context.issues
	for (const member of membersOf(root)) {
		context.issues = []
		const output = walk(member, value, context, true, false)
		if (output !== FAIL) {
			context.issues = issues
			return output
		}
	}
	context.issues = issues
	context.add('invalid_union', 'Invalid input: no union member matched', undefined)
	return FAIL
}

function walkDiscriminated(
	root: KNode,
	value: Record<string, unknown>,
	context: WalkContext,
	full: boolean,
): unknown {
	const plan = planOf(root)
	// SAFETY: k.discriminatedUnion stores its key with the options as the root argument.
	const { key } = root.arg as KDiscriminated
	const discriminator = value[key]
	// SAFETY: rootPlan records a dispatch table for every discriminated union root.
	const option = (plan.dispatch as ReadonlyMap<unknown, KNode>).get(discriminator)
	if (option === undefined) {
		context.add('invalid_union', `Invalid discriminator value at ${JSON.stringify(key)}`, [key])
		return FAIL
	}
	return walk(option, value, context, full, false)
}

/** A transform or overwrite is synchronous; a promise or a conversion failure becomes an issue. */
function callbackResult(output: unknown, context: WalkContext, kind: string): unknown {
	if (output instanceof KConversionFailure) {
		context.add('invalid_value', output.message, undefined)
		return FAIL
	}
	if (!isThenable(settled(output))) return output
	context.add(
		'custom',
		`Async ${kind} is not supported: ${kind} callbacks must be synchronous`,
		undefined,
	)
	return FAIL
}

/**
 * A check is synchronous. One that returns a promise (an untyped caller's async callback) fails, and
 * its rejection is contained so no detail escapes as an unhandled rejection.
 */
function settled(result: unknown): unknown {
	if (isThenable(result)) result.then(undefined, () => {})
	return result
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		value !== null &&
		(typeof value === 'object' || typeof value === 'function') &&
		'then' in value &&
		typeof value.then === 'function'
	)
}

const recordKeyMessage =
	"Invalid record key: Convex record keys are non-empty ASCII, at most 1024 characters, and do not start with '$' or '_'"

/** The Convex record key rule (`v.record`), applied to the key after normalisation. */
function isRecordKey(key: string): boolean {
	if (key.length === 0 || key.length > 1024 || key[0] === '$' || key[0] === '_') return false
	for (let index = 0; index < key.length; index++) {
		const code = key.charCodeAt(index)
		if (code < 32 || code >= 127) return false
	}
	return true
}

/** Write an own data property: a key taken from input (`__proto__`) never reaches a setter. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	})
}

function invalidType(context: WalkContext, expected: string, value: unknown): typeof FAIL {
	const instance = isInstance(value) && (expected === 'object' || expected === 'record')
	context.add(
		'invalid_type',
		instance
			? `Invalid input: expected a plain ${expected}, received an instance of ${instanceName(value)}`
			: `Invalid input: expected ${expected}, received ${receivedOf(value)}`,
		undefined,
	)
	return FAIL
}

function receivedOf(value: unknown): string {
	if (value === null) return 'null'
	if (Array.isArray(value)) return 'array'
	if (value instanceof ArrayBuffer) return 'ArrayBuffer'
	return typeof value
}

/**
 * An object that is not plain: a class instance (an Effect tagged error, an SDK error), a `Date`, a
 * `Map`. Arrays and `ArrayBuffer`s have their own messages and are never read as objects.
 */
function isInstance(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		!(value instanceof ArrayBuffer) &&
		!isPlainObject(value)
	)
}

function instanceName(value: Record<string, unknown>): string {
	const name: unknown = Object.getPrototypeOf(value)?.constructor?.name
	return typeof name === 'string' && name !== '' ? name : 'a class'
}

/**
 * A `.strip()` object parses a class instance from its own enumerable properties only, copied into a
 * fresh plain object: nothing is read through the prototype chain, and the output never keeps the
 * instance's prototype. Arguments and stored documents are plain, so this only affects in-memory parses.
 */
function ownSnapshot(value: Record<string, unknown>) {
	const snapshot: Record<string, unknown> = {}
	for (const key of Object.keys(value)) setOwn(snapshot, key, value[key])
	return snapshot
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function isJson(value: unknown): boolean {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
	if (typeof value === 'number') return Number.isFinite(value)
	if (Array.isArray(value)) return value.every(isJson)
	if (!isPlainObject(value)) return false
	for (const key in value) if (!isJson(value[key])) return false
	return true
}

function sizeOf(value: unknown): number {
	if (typeof value === 'string' || Array.isArray(value)) return value.length
	return Number(value)
}

function unitOf(value: unknown, limit: number, relation: string): string {
	if (typeof value === 'string') return `string to have ${relation}${limit} characters`
	if (Array.isArray(value)) return `array to have ${relation}${limit} items`
	return `number to be ${relation}${limit}`
}

function messageOf(record: KNode, fallback: string): string {
	const message = record.message
	if (typeof message === 'string') return message
	return message?.message ?? fallback
}

function optionsOf(record: KNode): KRefineOptions | undefined {
	const message = record.message
	return typeof message === 'string' ? { message } : message
}

function quoted(value: string): string {
	return JSON.stringify(value)
}

function isRunOp(record: KNode): boolean {
	switch (record.op) {
		case 'min':
		case 'max':
		case 'length':
		case 'regex':
		case 'int':
		case 'refine':
		case 'check':
		case 'trim':
		case 'lower':
		case 'upper':
		case 'overwrite':
			return true
		default:
			return false
	}
}

function isNormaliser(record: KNode): boolean {
	return (
		record.op === 'trim' ||
		record.op === 'lower' ||
		record.op === 'upper' ||
		record.op === 'overwrite'
	)
}

/** Whether a default sits inside an optional wrapper, so `undefined` still receives it (as in Zod 4). */
function defaultsBelow(node: KNode): boolean {
	for (let current: KNode | null = node; current !== null; current = current.prev) {
		if (current.op === 'default') return true
		if (current.op === 'transform' || current.op === 'pipe') return false
	}
	return false
}

function rootOf(node: KNode): KNode {
	let root = node
	while (root.prev !== null) root = root.prev
	return root
}

function asSchema(value: unknown): KNode {
	// SAFETY: every schema reachable from a k root was created by a k factory.
	return value as KNode
}

function argSchema(record: KNode): KNode {
	return asSchema(record.arg)
}

function fieldsOf(root: KNode): KFields {
	// SAFETY: k.object stores its field map as the root argument.
	return root.arg as KFields
}

function recordOf(root: KNode): readonly KNode[] {
	// SAFETY: k.record stores its key and value schemas as the root argument.
	return root.arg as readonly KType[]
}

function literalOf(root: KNode): KLiteralValue {
	// SAFETY: k.literal stores its literal value as the root argument.
	return root.arg as KLiteralValue
}

function enumOf(root: KNode): readonly string[] {
	// SAFETY: k.enum stores its value list as the root argument.
	return root.arg as readonly string[]
}

function numberArg(record: KNode): number {
	// SAFETY: min, max and length store their numeric limit as the record argument.
	return record.arg as number
}

function stringOf(value: unknown): string {
	// SAFETY: string normalisers and record keys run only after the string structure check passed.
	return value as string
}

function callbackOf(record: KNode): (value: unknown, context?: CheckContext) => unknown {
	// SAFETY: refine, check, overwrite and transform store their callback as the record argument.
	return record.arg as (value: unknown, context?: CheckContext) => unknown
}
