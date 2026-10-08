/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unknown-type-aliases, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- This neutral contract validates unknown transport data and an explicitly keyed code/detail declaration. */

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
	project: (error: unknown) => DecodedFailure<Definitions>
	/** Receives envelope data, e.g. ConvexError.data; never parses error messages. */
	decode: (payload: unknown) => DecodedFailure<Definitions>
}>

const unknownFailure: UnknownFailure = Object.freeze({ _tag: 'UnknownFailure', version: 1 })
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
	return {
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
