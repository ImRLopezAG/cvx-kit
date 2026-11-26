/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unknown-type-aliases, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- This neutral contract validates unknown transport data and an explicitly keyed code/detail declaration. */

import { ConvexError } from 'convex/values'

/** Explicit synchronous validators for the final public detail representation. */
export type ErrorDetailParser<Output = unknown> = Readonly<{
	parse: (value: unknown) => Output
}>

export type ErrorDefinitions = Readonly<
	Record<
		string,
		Readonly<{
			message: string
			details: Readonly<Record<string, ErrorDetailParser>>
		}>
	>
>

type Code<Definitions extends ErrorDefinitions> = Extract<keyof Definitions, string>
type Details<Definition extends ErrorDefinitions[string]> =
	Definition extends ErrorDefinitions[string]
		? { [Field in keyof Definition['details']]: ReturnType<Definition['details'][Field]['parse']> }
		: never
/** The parsed detail fields one declared code carries. */
export type DeclaredErrorDetails<
	Definitions extends ErrorDefinitions,
	Key extends Code<Definitions>,
> = Details<Definitions[Key]>

declare const declaredErrorBrand: unique symbol

/** Server failures are trusted only by the contract that created them. */
export type DeclaredError<Definitions extends ErrorDefinitions> = {
	[Key in Code<Definitions>]: Readonly<{
		_tag: 'DeclaredError'
		code: Key
		details: Details<Definitions[Key]>
		[declaredErrorBrand]: true
	}>
}[Code<Definitions>]

export type DeclaredFailure<Definitions extends ErrorDefinitions> = {
	[Key in Code<Definitions>]: Readonly<{
		_tag: 'DeclaredFailure'
		version: 1
		code: Key
		message: string
		details: Details<Definitions[Key]>
	}>
}[Code<Definitions>]

export type UnknownFailure = Readonly<{ _tag: 'UnknownFailure'; version: 1 }>
export type DecodedFailure<Definitions extends ErrorDefinitions> =
	| DeclaredFailure<Definitions>
	| UnknownFailure

export type ErrorContract<Definitions extends ErrorDefinitions> = Readonly<{
	create: <Key extends Code<Definitions>>(
		code: Key,
		details: Details<Definitions[NoInfer<Key>]>,
	) => Extract<DeclaredError<Definitions>, { code: Key }>
	envelope: <Key extends Code<Definitions>>(
		code: Key,
		details: Details<Definitions[NoInfer<Key>]>,
	) => Extract<DeclaredFailure<Definitions>, { code: Key }>
	toConvexError: <Key extends Code<Definitions>>(
		code: Key,
		details: Details<Definitions[NoInfer<Key>]>,
	) => ConvexError<Extract<DeclaredFailure<Definitions>, { code: Key }>>
	project: (error: unknown) => DecodedFailure<Definitions>
	/** Receives envelope data, e.g. ConvexError.data; never parses error messages. */
	decode: (payload: unknown) => DecodedFailure<Definitions>
}>

const unknownFailure: UnknownFailure = Object.freeze({
	_tag: 'UnknownFailure',
	version: 1,
})
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Closed safe codes, allowlisted details, and a versioned checked transport union. */
export function defineErrorContract<const Definitions extends ErrorDefinitions>(
	definitions: Definitions,
): ErrorContract<Definitions> {
	// SAFETY: the snapshot copies every declaration without changing its code, message or paired parsers.
	const declarations = Object.fromEntries(
		Object.entries(definitions).map(([code, definition]) => {
			if (!code || !definition.message || definition.message.length > 200) {
				throw Error('Declared errors require a code and a public message of 1–200 characters')
			}
			return [code, { message: definition.message, details: { ...definition.details } }]
		}),
	) as Definitions
	const trusted = new WeakMap<object, DeclaredFailure<Definitions>>()
	const contract: ErrorContract<Definitions> = {
		create(code, details) {
			let envelope: DeclaredFailure<Definitions>
			try {
				if (!Object.hasOwn(declarations, code)) throw Error('Undeclared code')
				const definition = declarations[code]
				// SAFETY: the selected closed declaration validates every field before construction.
				envelope = {
					_tag: 'DeclaredFailure',
					version: 1,
					code,
					message: definition.message,
					details: parseDetails(definition, details, false),
				} as DeclaredFailure<Definitions>
			} catch {
				// Validator messages, issue paths and provider causes remain private.
				throw Error('Invalid declared error details')
			}
			// SAFETY: identity is registered below; the inaccessible brand cannot confer trust by itself.
			const error = Object.freeze({
				_tag: 'DeclaredError',
				code,
				details: copyJson(envelope.details),
			}) as Extract<DeclaredError<Definitions>, { code: typeof code }>
			trusted.set(error, envelope)
			return error
		},
		envelope(code, details) {
			// SAFETY: create validates the selected code; project retrieves its private validated envelope.
			return contract.project(contract.create(code, details)) as Extract<
				DeclaredFailure<Definitions>,
				{ code: typeof code }
			>
		},
		toConvexError(code, details) {
			return new ConvexError(contract.envelope(code, details))
		},
		project(error) {
			if (error === null || typeof error !== 'object') return unknownFailure
			const envelope = trusted.get(error)
			// SAFETY: only validated contract-owned envelopes enter the private map.
			return envelope ? (copyJson(envelope) as DeclaredFailure<Definitions>) : unknownFailure
		},
		decode(payload) {
			try {
				if (
					!isRecord(payload) ||
					payload._tag !== 'DeclaredFailure' ||
					payload.version !== 1 ||
					typeof payload.code !== 'string' ||
					!Object.hasOwn(declarations, payload.code) ||
					Object.keys(payload).length !== 5 ||
					!['message', 'details', '_tag', 'version', 'code'].every((key) =>
						Object.hasOwn(payload, key),
					)
				) {
					return unknownFailure
				}
				const definition = declarations[payload.code]
				if (payload.message !== definition.message) return unknownFailure
				// Validate raw transport JSON too: parsers must not hide non-JSON payloads.
				copyJson(payload.details)
				// SAFETY: code membership and every allowlisted field have been checked independently.
				return {
					_tag: 'DeclaredFailure',
					version: 1,
					code: payload.code,
					message: definition.message,
					details: parseDetails(definition, payload.details, true),
				} as DeclaredFailure<Definitions>
			} catch {
				return unknownFailure
			}
		},
	}
	return contract
}

/** A structural decoder also accepts combined contracts without requiring constructors. */
export type FailureContract = Pick<ErrorContract<ErrorDefinitions>, 'decode'>
export type FailureOf<Contract extends FailureContract> = ReturnType<Contract['decode']>
type ProjectingContract = FailureContract & Pick<ErrorContract<ErrorDefinitions>, 'project'>

/** Extract only ConvexError.data, including one bounded serialized JSON envelope. */
export function decodeFailure<Contract extends FailureContract>(
	error: unknown,
	contract: Contract,
): FailureOf<Contract> {
	try {
		if (error instanceof ConvexError) {
			let payload: unknown = error.data
			if (typeof payload === 'string') {
				if (payload.length > 65536 || new TextEncoder().encode(payload).byteLength > 65536)
					// SAFETY: every failure decoder includes UnknownFailure.
					return unknownFailure as FailureOf<Contract>
				payload = JSON.parse(payload)
			}
			// SAFETY: the structural contract owns the decoded union.
			return contract.decode(payload) as FailureOf<Contract>
		}
	} catch {
		// Foreign errors, accessors and invalid JSON expose no diagnostics.
	}
	// SAFETY: every failure decoder includes UnknownFailure.
	return unknownFailure as FailureOf<Contract>
}

type CombinedErrorContract<Contracts extends readonly ProjectingContract[]> = Readonly<{
	project: (error: unknown) => FailureOf<Contracts[number]> | UnknownFailure
	decode: (payload: unknown) => FailureOf<Contracts[number]> | UnknownFailure
}>

/** Ordered projection and decoding; duplicate codes retain the union of member details. */
export function combineErrorContracts<const Contracts extends readonly ProjectingContract[]>(
	...contracts: Contracts
): CombinedErrorContract<Contracts> {
	const unmatched = unknownFailure
	return {
		project(error) {
			for (const contract of contracts) {
				const projected = contract.project(error)
				if (projected._tag === 'DeclaredFailure') {
					// SAFETY: this result belongs to a member of the inferred tuple.
					return projected as FailureOf<Contracts[number]>
				}
				const decoded = decodeFailure(error, contract)
				if (decoded._tag === 'DeclaredFailure') {
					// SAFETY: strict transported decoding preserves the same member union.
					return decoded as FailureOf<Contracts[number]>
				}
			}
			return unmatched
		},
		decode(payload) {
			for (const contract of contracts) {
				const decoded = contract.decode(payload)
				if (decoded._tag === 'DeclaredFailure') {
					// SAFETY: this result belongs to a member of the inferred tuple.
					return decoded as FailureOf<Contracts[number]>
				}
			}
			return unmatched
		},
	}
}

/** Fixed, diagnostic-free transport shared by query endpoints and client recovery. */
export const queryErrors = defineErrorContract({
	'invalid-cursor': { message: 'Invalid cursor', details: {} },
	FIELD_GROUP_DENIED: { message: 'Field group access denied', details: {} },
	QUERY_FANOUT: { message: 'Query fan-out limit exceeded', details: {} },
	SEARCH_TEXT_REQUIRED: { message: 'Search text required', details: {} },
	SEARCH_END_CURSOR_UNSUPPORTED: {
		message: 'Search end cursor unsupported',
		details: {},
	},
	SEARCH_ORDER_UNSUPPORTED: {
		message: 'Search ordering unsupported',
		details: {},
	},
	SEARCH_RELATION_UNSUPPORTED: {
		message: 'Relation search unsupported',
		details: {},
	},
	SEARCH_OPTIONS_UNSUPPORTED: {
		message: 'Search options unsupported',
		details: {},
	},
	SEARCH_PROTOCOL_UNSUPPORTED: {
		message: 'Search pagination protocol unsupported',
		details: {},
	},
})

/** One allowlisted, bounded argument issue. The rejected input value is never carried. */
export type ArgumentIssue = Readonly<{
	// Mutable so the envelope stays assignable to Convex `Value`.
	path: (string | number)[]
	code: string
	message: string
}>

/** Bounds applied to every emitted and decoded argument failure. */
export const ARGUMENT_ISSUE_LIMITS = Object.freeze({
	issues: 20,
	pathSegments: 32,
	segmentLength: 128,
	codeLength: 64,
	messageLength: 256,
	/** Serialized UTF-8 budget for all issues, so an envelope always fits the transport decoder. */
	totalBytes: 32_768,
})

/**
 * Allowlist and bound provider issues (e.g. zod `error.issues`). Only `path`, `code` and
 * `message` survive; `input`, `received`, `params` and nested errors are dropped.
 * Messages and path segments are passed as the schema produced them, exactly as the legacy
 * payload does: a schema whose own message interpolates the rejected value still exposes it.
 */
export function sanitizeArgumentIssues(issues: unknown): ArgumentIssue[] {
	if (!Array.isArray(issues)) return []
	const limits = ARGUMENT_ISSUE_LIMITS
	const result: ArgumentIssue[] = []
	let bytes = 0
	for (const issue of issues.slice(0, limits.issues)) {
		if (issue === null || typeof issue !== 'object') continue
		// SAFETY: a non-null object; every field read below is type-checked before use.
		const { path, code, message } = issue as { path?: unknown; code?: unknown; message?: unknown }
		const entry: ArgumentIssue = {
			path: Array.isArray(path)
				? path
						.slice(0, limits.pathSegments)
						.map((segment: unknown) =>
							typeof segment === 'number' && Number.isFinite(segment)
								? segment
								: typeof segment === 'string'
									? bounded(segment, limits.segmentLength)
									: '',
						)
				: [],
			code: typeof code === 'string' && code ? bounded(code, limits.codeLength) : 'custom',
			message:
				typeof message === 'string' && message
					? bounded(message, limits.messageLength)
					: 'Invalid value',
		}
		// Later issues are dropped once the serialized total would exceed the transport budget.
		bytes += new TextEncoder().encode(JSON.stringify(entry)).length + 1
		if (bytes > limits.totalBytes) break
		result.push(entry)
	}
	return result
}

/** Built-in declared contract for rejected function arguments. */
export const argumentErrors = defineErrorContract({
	INVALID_ARGUMENTS: {
		message: 'Invalid arguments',
		details: { issues: { parse: parseArgumentIssues } },
	},
})

/** What an app hook receives when arguments are rejected. */
export type ArgumentFailure = Readonly<{
	/** `arguments`: a function or operation input schema; `filter`: the compact pagination filter guard. */
	source: 'arguments' | 'filter'
	issues: readonly ArgumentIssue[]
}>

/**
 * How argument rejections are thrown:
 * - `'legacy'` (default): preserve the existing throw at that validation boundary.
 * - `'declared'`: `argumentErrors.toConvexError('INVALID_ARGUMENTS', { issues })`.
 * - a function: its return value is thrown (e.g. the app's own `toConvexError`).
 */
export type ArgumentFailurePolicy = 'legacy' | 'declared' | ((failure: ArgumentFailure) => unknown)

/** Plain object records only: no arrays, class instances or exotic prototypes. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

/** Copy data without invoking toJSON or retaining mutable provider objects. */
function copyJson(value: unknown, ancestors = new Set<object>()): Json {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value !== 'object' || value === null || ancestors.has(value))
		throw Error('Invalid JSON')
	ancestors.add(value)
	try {
		if (Array.isArray(value)) {
			const result: Json[] = []
			for (let index = 0; index < value.length; index++)
				result.push(copyJson(value[index], ancestors))
			return result
		}
		if (!isRecord(value)) throw Error('Invalid JSON')
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [key, copyJson(child, ancestors)]),
		)
	} finally {
		ancestors.delete(value)
	}
}

function parseDetails<const Definition extends ErrorDefinitions[string]>(
	definition: Definition,
	value: unknown,
	strict: boolean,
): Details<Definition> {
	if (!isRecord(value)) throw Error('Invalid details')
	const fields = Object.keys(definition.details)
	if (strict && Object.keys(value).some((key) => !Object.hasOwn(definition.details, key))) {
		throw Error('Undeclared detail')
	}
	// SAFETY: each declared field is validated by its paired parser before its JSON-safe copy is returned.
	return Object.fromEntries(
		fields.map((field) => {
			if (!Object.hasOwn(value, field)) throw Error('Missing detail')
			return [field, copyJson(definition.details[field].parse(value[field]))]
		}),
	) as Details<Definition>
}

function bounded(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value
}

/** Strict parser for transported issue lists: exact keys and bounded sizes. */
function parseArgumentIssues(value: unknown): ArgumentIssue[] {
	const limits = ARGUMENT_ISSUE_LIMITS
	if (!Array.isArray(value) || value.length > limits.issues) throw Error('Invalid issues')
	return value.map((issue) => {
		if (
			!isRecord(issue) ||
			Object.keys(issue).length !== 3 ||
			!Array.isArray(issue.path) ||
			issue.path.length > limits.pathSegments ||
			typeof issue.code !== 'string' ||
			issue.code.length > limits.codeLength ||
			typeof issue.message !== 'string' ||
			issue.message.length > limits.messageLength
		)
			throw Error('Invalid issue')
		for (const segment of issue.path)
			if (
				!(typeof segment === 'number' && Number.isFinite(segment)) &&
				!(typeof segment === 'string' && segment.length <= limits.segmentLength)
			)
				throw Error('Invalid issue path')
		return { path: [...issue.path], code: issue.code, message: issue.message }
	})
}
