/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Cursor transport and canonical values are explicit validation boundaries. */
import { aessiv } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils.js'
import type { Value } from 'convex/values'
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
				const cipher = aessiv(keys.get(currentKeyId)!, aad(version, currentKeyId, binding))
				return `pc.${version}.${currentKeyId}.${bytesToHex(cipher.encrypt(payload))}`
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
					parts[0] !== 'pc' ||
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
				const cipher = aessiv(key, aad(version, keyId, binding))
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

/** Reject accessor-bearing arrays/dictionaries before the shared canonical encoder reads values. */
function checkDescriptors(value: unknown): void {
	const ancestors = new Set<object>()
	let nodes = 0
	function visit(current: unknown, depth: number): void {
		if (++nodes > bounds.maxNodes || depth > bounds.maxDepth) throw new CursorError()
		if (current === null || typeof current !== 'object' || current instanceof ArrayBuffer) return
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
function aad(version: string, keyId: string, binding: CursorBinding): Uint8Array {
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
				domain: 'cvx-query-cursor',
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
