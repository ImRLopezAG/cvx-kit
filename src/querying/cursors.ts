/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Cursor transport and canonical values are explicit validation boundaries. */
import { aessiv } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils.js'
import { jsonToConvex, type Value, type JSONValue } from 'convex/values'
import type { KSchema, KType } from '../k'

/** A `k` schema whose parsed output is a Convex value, as a cursor payload must be. */
export type KCursorSchema = KType & { readonly _output: Value }
import type { ManagedScope } from './security'
import { canonicalConvexBytes } from '../modules/contracts/idempotency'

/** Private engine contract. Bindings must come from trusted normalized engine state, never query args. */
export interface CursorBinding {
	readonly table: string
	readonly index?: string | null
	readonly order: 'asc' | 'desc'
	readonly clientFilters: Value
	readonly serverFilters: Value
	readonly relationPath: readonly string[]
	readonly parent?: string | null
	readonly principal: string
	readonly tenant?: string | null
	readonly policyVersion: string
	readonly engineVersion: string
	readonly registryVersion: string
	/** Deliberately excluded from authenticated identity. */
	readonly pageSize?: number
}
export interface CursorCodecConfig {
	readonly version: string
	readonly currentKeyId: string
	readonly keys: Readonly<Record<string, Uint8Array>>
}
export class CursorError extends Error {
	readonly _tag = 'CursorError'
	readonly code = 'invalid-cursor'
	constructor() {
		super('Invalid cursor')
		this.name = 'CursorError'
	}
}
export class CursorConfigurationError extends Error {
	readonly _tag = 'CursorConfigurationError'
	constructor() {
		super('Invalid cursor server configuration')
		this.name = 'CursorConfigurationError'
	}
}

const bounds = Object.freeze({
	maxDepth: 24,
	maxNodes: 2048,
	maxBytes: 16384,
	maxArrayLength: 512,
	maxObjectFields: 128,
})
const maxPlaintextBytes = 8192
// JSON string encoding preserves even lone UTF-16 surrogates without lossy UTF-8 replacement.
const maxPayloadBytes = maxPlaintextBytes * 6 + 2
const maxCiphertextBytes = maxPayloadBytes + 16
const maxTokenLength = maxCiphertextBytes * 2 + 70
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const identifier = /^[A-Za-z0-9_-]{1,32}$/

/** Private lazy server configuration. Call only at the first pagination boundary. */
export function createEnvironmentCursorCodec() {
	try {
		const encoded = process.env.CVX_QUERY_CURSOR_KEYS_JSON
		const currentKeyId = process.env.CVX_QUERY_CURSOR_CURRENT_KEY_ID
		if (!encoded || !currentKeyId) throw new CursorConfigurationError()
		const parsed: unknown = JSON.parse(encoded)
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
			throw new CursorConfigurationError()
		const keys = Object.fromEntries(
			Object.entries(parsed).map(([id, key]) => {
				if (typeof key !== 'string' || !/^[0-9a-fA-F]{128}$/.test(key))
					throw new CursorConfigurationError()
				return [id, hexToBytes(key)]
			}),
		)
		return createCursorCodec({ version: '1', currentKeyId, keys })
	} catch {
		// Parsing/runtime failures must never expose key material or environment values.
		throw new CursorConfigurationError()
	}
}

/**
 * Deterministic RFC 5297 AES-SIV: equal plaintext and binding leak equality.
 * One navigation-boundary family permits native split/continue tokens in start/end
 * slots. Relation identity remains in the binding. No nonce/randomness or plaintext fallback. Opening is not authorization: the engine
 * must recheck current policy on every future request, including nested continuations.
 */
export function createCursorCodec(config: CursorCodecConfig) {
	let version: string, currentKeyId: string
	const keys = new Map<string, Uint8Array>()
	try {
		version = config.version
		currentKeyId = config.currentKeyId
		if (
			typeof version !== 'string' ||
			typeof currentKeyId !== 'string' ||
			!identifier.test(version) ||
			!identifier.test(currentKeyId)
		)
			throw new CursorConfigurationError()
		const entries = Object.entries(config.keys)
		if (!entries.length) throw new CursorConfigurationError()
		for (const [id, key] of entries) {
			if (!identifier.test(id) || !(key instanceof Uint8Array) || key.byteLength !== 64)
				throw new CursorConfigurationError()
			keys.set(id, Uint8Array.from(key))
		}
		if (!keys.has(currentKeyId)) throw new CursorConfigurationError()
	} catch {
		throw new CursorConfigurationError()
	}
	function transport(namespace: 'pc' | 'cc') {
		return Object.freeze({
			seal(raw: string, binding: CursorBinding): string {
				try {
					if (
						typeof raw !== 'string' ||
						raw.length > maxPlaintextBytes ||
						encoder.encode(raw).length > maxPlaintextBytes
					)
						throw new CursorError()
					const payload = encoder.encode(JSON.stringify(raw))
					const cipher = aessiv(
						keys.get(currentKeyId)!,
						aad(version, currentKeyId, binding, namespace),
					)
					return `${namespace}.${version}.${currentKeyId}.${bytesToHex(cipher.encrypt(payload))}`
				} catch {
					throw new CursorError()
				}
			},
			open(token: string, binding: CursorBinding): string {
				try {
					if (typeof token !== 'string' || token.length > maxTokenLength) throw new CursorError()
					const parts = token.split('.')
					if (
						parts.length !== 4 ||
						parts[0] !== namespace ||
						parts[1] !== version ||
						!identifier.test(parts[2]!)
					)
						throw new CursorError()
					const keyId = parts[2]!,
						encoded = parts[3]!,
						key = keys.get(keyId)
					if (
						!key ||
						encoded.length < 36 ||
						encoded.length > maxCiphertextBytes * 2 ||
						encoded.length % 2 ||
						!/^[0-9a-f]+$/.test(encoded)
					)
						throw new CursorError()
					const cipher = aessiv(key, aad(version, keyId, binding, namespace))
					const plaintext = cipher.decrypt(hexToBytes(encoded))
					if (plaintext.length > maxPayloadBytes) throw new CursorError()
					const json = decoder.decode(plaintext)
					const raw: unknown = JSON.parse(json)
					if (
						typeof raw !== 'string' ||
						raw.length > maxPlaintextBytes ||
						encoder.encode(raw).length > maxPlaintextBytes ||
						JSON.stringify(raw) !== json
					)
						throw new CursorError()
					return raw
				} catch {
					throw new CursorError()
				}
			},
		})
	}
	return Object.freeze({ ...transport('pc'), custom: transport('cc') })
}

/** Server-derived binding supplements managed scope; opening never grants row access. */
export interface ScopedCursorOptions<S extends KCursorSchema> {
	readonly domain: string
	readonly bind: Value
	/** A `k` schema, applied on seal AND open. Outputs must be bounded Convex values. */
	readonly schema: S
}
/** Integrity only: consumers must recheck current authorization on every request. */
export interface ScopedCursorCodec<S extends KCursorSchema> {
	seal(payload: S['validator']['type']): string
	open(token: string): S['_output']
}

/** Internal construction uses the configured engine's already captured key ring. */
export function createScopedCursorCodec<S extends KCursorSchema>(
	transport: ReturnType<typeof createCursorCodec>['custom'],
	scope: ManagedScope & { readonly policyVersion: string },
	options: ScopedCursorOptions<S>,
): ScopedCursorCodec<S> {
	const schema = schemaOf(options.schema)
	return scopedCursorCodec<S['validator']['type'], S['_output']>(transport, scope, {
		domain: options.domain,
		bind: options.bind,
		parse: (value): S['_output'] => synchronous(schema.parse(value)),
	})
}

/** The parse step a scoped codec applies on seal and open; it must be synchronous. */
export interface ScopedCursorParser<Output> {
	readonly domain: string
	readonly bind: Value
	parse(value: unknown): Output
}

/**
 * The scoped codec around any synchronous parser. `createScopedCursorCodec` supplies the `k` parse;
 * the v1 bridge supplies its guarded Zod parse until the cutover.
 */
export function scopedCursorCodec<Input, Output>(
	transport: ReturnType<typeof createCursorCodec>['custom'],
	scope: ManagedScope & { readonly policyVersion: string },
	options: ScopedCursorParser<Output>,
): { seal(payload: Input): string; open(token: string): Output } {
	try {
		checkDescriptors(options.bind)
		if (typeof options.domain !== 'string' || !options.domain.length || options.domain.length > 256)
			throw new CursorError()
		// Snapshot bind bytes before returning: later caller mutation cannot change identity.
		const binding: CursorBinding = {
			table: options.domain,
			order: 'asc',
			principal: 'custom',
			policyVersion: scope.policyVersion,
			engineVersion: 'custom-1',
			registryVersion: 'custom-1',
			relationPath: [],
			clientFilters: jsonToValue(JSON.parse(canonicalConvexBytes(options.bind, bounds))),
			serverFilters: { ...scope },
		}
		// Validate the combined identity even before any seal/open call.
		aad('1', 'validation', binding, 'cc')
		const parse = options.parse
		function encode(value: unknown): string {
			checkDescriptors(value)
			return canonicalConvexBytes(value, { ...bounds, maxBytes: maxPlaintextBytes })
		}
		function validate(value: unknown): Output {
			encode(value)
			const parsed = parse(value)
			encode(parsed)
			return parsed
		}
		return Object.freeze({
			seal(payload: Input): string {
				try {
					// Validate output too, but retain input bytes so open applies transforms once.
					validate(payload)
					return transport.seal(encode(payload), binding)
				} catch {
					throw new CursorError()
				}
			},
			open(token: string): Output {
				try {
					const raw = transport.open(token, binding)
					const value = jsonToValue(JSON.parse(raw))
					if (encode(value) !== raw) throw new CursorError()
					return validate(value)
				} catch {
					throw new CursorError()
				}
			},
		})
	} catch {
		throw new CursorError()
	}
}

/**
 * A `k` parse never awaits, but a transform may still return a promise. Reject it, and any promise
 * nested in the output, before encoding, and contain its rejection so no detail escapes.
 */
function synchronous<Output>(result: Output): Output {
	const pending: unknown[] = [result]
	let nodes = 0
	while (pending.length) {
		const current = pending.pop()
		if (++nodes > bounds.maxNodes) throw new CursorError()
		if (current === null || (typeof current !== 'object' && typeof current !== 'function')) continue
		if ('then' in current && typeof current.then === 'function') {
			void Promise.resolve(current).catch(() => {})
			throw new CursorError()
		}
		if (typeof current === 'function' || current instanceof ArrayBuffer) continue
		for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current)))
			if ('value' in descriptor) pending.push(descriptor.value)
	}
	return result
}

function schemaOf(schema: KType): KSchema<any, any, any, any, any> {
	// SAFETY: every KType at runtime is a k schema record, whose parse is synchronous and yields its output.
	return schema as KSchema<any, any, any, any, any>
}

/** Preserve own __proto__ fields; SDK scalar conversion handles integer/binary/float tags. */
function jsonToValue(value: JSONValue, depth = 0): Value {
	if (depth > bounds.maxDepth) throw new CursorError()
	if (Array.isArray(value)) return value.map((item) => jsonToValue(item, depth + 1))
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value)
		if (entries.some(([key]) => key.startsWith('$'))) return jsonToConvex(value)
		return Object.fromEntries(entries.map(([key, item]) => [key, jsonToValue(item, depth + 1)]))
	}
	return jsonToConvex(value)
}

/** Reject accessor-bearing arrays/dictionaries before the shared canonical encoder reads values. */
function checkDescriptors(value: unknown): void {
	const ancestors = new Set<object>()
	let nodes = 0
	function visit(current: unknown, depth: number): void {
		if (++nodes > bounds.maxNodes || depth > bounds.maxDepth) throw new CursorError()
		if (current === null || typeof current !== 'object') return
		if (current instanceof ArrayBuffer) {
			if (
				Object.getPrototypeOf(current) !== ArrayBuffer.prototype ||
				Object.getOwnPropertyNames(current).length ||
				Object.getOwnPropertySymbols(current).length
			)
				throw new CursorError()
			return
		}
		if (ancestors.has(current)) throw new CursorError()
		const array = Array.isArray(current)
		if (array && Object.getPrototypeOf(current) !== Array.prototype) throw new CursorError()
		if (
			!array &&
			Object.getPrototypeOf(current) !== Object.prototype &&
			Object.getPrototypeOf(current) !== null
		)
			throw new CursorError()
		if (Object.getOwnPropertySymbols(current).length) throw new CursorError()
		const names = Object.getOwnPropertyNames(current)
		if (names.length > (array ? bounds.maxArrayLength + 1 : bounds.maxObjectFields))
			throw new CursorError()
		ancestors.add(current)
		try {
			for (const name of names) {
				const descriptor = Object.getOwnPropertyDescriptor(current, name)!
				if (!('value' in descriptor)) throw new CursorError()
				if (array && name === 'length') {
					if (descriptor.value > bounds.maxArrayLength) throw new CursorError()
					continue
				}
				if (
					!descriptor.enumerable ||
					(array && (!/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= current.length))
				)
					throw new CursorError()
				visit(descriptor.value, depth + 1)
			}
		} finally {
			ancestors.delete(current)
		}
	}
	visit(value, 0)
}
function aad(
	version: string,
	keyId: string,
	binding: CursorBinding,
	namespace: 'pc' | 'cc',
): Uint8Array {
	checkDescriptors(binding)
	if (binding.clientFilters === undefined || binding.serverFilters === undefined)
		throw new CursorError()
	const { table, order, principal, policyVersion, engineVersion, registryVersion } = binding
	for (const field of [table, principal, policyVersion, engineVersion, registryVersion])
		if (typeof field !== 'string' || !field.length) throw new CursorError()
	if (order !== 'asc' && order !== 'desc') throw new CursorError()
	for (const field of [binding.index, binding.parent, binding.tenant])
		if (field != null && typeof field !== 'string') throw new CursorError()
	if (
		!Array.isArray(binding.relationPath) ||
		binding.relationPath.some((part) => typeof part !== 'string')
	)
		throw new CursorError()
	return encoder.encode(
		canonicalConvexBytes(
			{
				domain: namespace === 'pc' ? 'cvx-query-cursor' : 'cvx-custom-cursor',
				version,
				keyId,
				table,
				index: binding.index ?? null,
				order,
				clientFilters: binding.clientFilters,
				serverFilters: binding.serverFilters,
				relationPath: binding.relationPath,
				parent: binding.parent ?? null,
				principal,
				tenant: binding.tenant ?? null,
				policyVersion,
				engineVersion,
				registryVersion,
			},
			bounds,
		),
	)
}
