/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Cursor transport and canonical values are explicit validation boundaries. */
import { aessiv } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils.js'
import { jsonToConvex, type Value, type JSONValue } from 'convex/values'
import { z } from 'zod'
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
export interface ScopedCursorOptions<S extends z.ZodType<Value>> {
	readonly domain: string
	readonly bind: Value
	/** Synchronous schema, applied on seal AND open. Outputs must be bounded Convex values. */
	readonly schema: S
}
/** Integrity only: consumers must recheck current authorization on every request. */
export interface ScopedCursorCodec<S extends z.ZodType<Value>> {
	seal(payload: z.input<S>): string
	open(token: string): z.output<S>
}

/** Internal construction uses the configured engine's already captured key ring. */
export function createScopedCursorCodec<S extends z.ZodType<Value>>(
	transport: ReturnType<typeof createCursorCodec>['custom'],
	scope: ManagedScope & { readonly policyVersion: string },
	options: ScopedCursorOptions<S>,
): ScopedCursorCodec<S> {
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
		const parse = synchronousCursorParser(options.schema)
		function encode(value: unknown): string {
			checkDescriptors(value)
			return canonicalConvexBytes(value, { ...bounds, maxBytes: maxPlaintextBytes })
		}
		function validate(value: unknown): z.output<S> {
			encode(value)
			const parsed = parse(value)
			encode(parsed)
			return parsed
		}
		return Object.freeze({
			seal(payload: z.input<S>): string {
				try {
					// Validate output too, but retain input bytes so open applies transforms once.
					validate(payload)
					return transport.seal(encode(payload), binding)
				} catch {
					throw new CursorError()
				}
			},
			open(token: string): z.output<S> {
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
 * Zod's sync parser throws AFTER starting async callbacks, losing their promises.
 * Rebuild an owned graph so callback results are contained before Zod sees them.
 * Uses Zod 4's definition/constructor seam (also used by its clone utility).
 */
/* oxlint-disable anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- The private walker preserves heterogeneous Zod definitions and callback results until their installed constructor restores the schema contract. */
function synchronousCursorParser<S extends z.ZodType>(schema: S): (value: unknown) => z.output<S> {
	const copies = new WeakMap<object, unknown>()
	const active = new WeakSet<object>()
	const attempts = new Set<{ asynchronous: boolean }>()
	function synchronous(result: unknown): unknown {
		if (
			result !== null &&
			(typeof result === 'object' || typeof result === 'function') &&
			'then' in result &&
			typeof result.then === 'function'
		) {
			for (const attempt of attempts) attempt.asynchronous = true
			// Attach before throwing, including foreign promises and ordinary functions
			// returning promises. Never propagate the callback's rejection details.
			void Promise.resolve(result).catch(() => {})
			throw new CursorError()
		}
		return result
	}
	function copy(value: unknown): unknown {
		if (typeof value === 'function') {
			return function (this: unknown, ...args: unknown[]) {
				const result = synchronous(value.apply(this, args))
				// Lazy schemas resolve at parse time; their children need the same boundary.
				return result instanceof z.core.$ZodType ? copy(result) : result
			}
		}
		if (value === null || typeof value !== 'object') return value
		if (copies.has(value)) return copies.get(value)
		if (active.has(value)) throw new CursorError()
		active.add(value)
		let result: unknown
		if (value instanceof z.core.$ZodType || value instanceof z.core.$ZodCheck) {
			const descriptors = Object.getOwnPropertyDescriptors(value._zod.def)
			// A previously parsed lazy schema caches its resolved graph here. Rebuild
			// it through the guarded getter so recursive references resolve to our copy.
			if ('type' in value._zod.def && value._zod.def.type === 'lazy')
				delete descriptors._cachedInner
			const definition = copy(Object.create(Object.getPrototypeOf(value._zod.def), descriptors))
			// Zod's check typings omit constr, but $constructor installs it on both
			// checks and schemas in the supported Zod 4 peers.
			// SAFETY: the installed constructor reconstructs the same schema/check kind.
			const Constructor = (
				value._zod as {
					constr: new (definition: unknown) => z.core.$ZodType | z.core.$ZodCheck
				}
			).constr
			const node = new Constructor(definition)
			if (node instanceof z.core.$ZodType && node._zod.def.type === 'promise') {
				// Promise schemas are intrinsically async, even with a synchronous child.
				// Reject before Zod schedules that child outside this sync boundary.
				node._zod.parse = node._zod.run = () => {
					for (const attempt of attempts) attempt.asynchronous = true
					throw new CursorError()
				}
			}
			if (
				value instanceof z.core.$ZodCheck &&
				value._zod.def.check === 'custom' &&
				!('type' in value._zod.def)
			) {
				if (!(node instanceof z.core.$ZodCheck)) throw new CursorError()
				// superRefine/check store their callback on the node, not in its definition.
				// SAFETY: copy wraps the original callback without changing its arguments or sync result.
				node._zod.check = copy(value._zod.check) as typeof value._zod.check
			}
			result = node
		} else if (Array.isArray(value)) {
			result = value.map((child) => copy(child))
		} else if (
			Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null
		) {
			// Defaults/prefaults use getters to invoke callbacks per parse. Keep them
			// lazy, while guarding their results just like definition callbacks.
			const descriptors = Object.getOwnPropertyDescriptors(value)
			for (const descriptor of Object.values(descriptors)) {
				if ('value' in descriptor) descriptor.value = copy(descriptor.value)
				else if (descriptor.get) {
					const getter = descriptor.get
					const get = () => copy(synchronous(getter.call(value)))
					// Zod object constructors reuse the raw shape behind this getter.
					if ('raw' in getter) Object.assign(get, { raw: copy(getter.raw) })
					descriptor.get = get
				}
			}
			result = Object.create(Object.getPrototypeOf(value), descriptors)
		} else {
			// RegExp and other literal definition values are not parser nodes.
			result = value
		}
		active.delete(value)
		copies.set(value, result)
		return result
	}
	// SAFETY: reconstruction preserves the root schema's input/output contract.
	const owned = copy(schema) as S
	return (value) => {
		const attempt = { asynchronous: false }
		attempts.add(attempt)
		try {
			const parsed = owned.parse(value)
			// A catch/fallback schema may swallow the thrown boundary error.
			if (attempt.asynchronous) throw new CursorError()
			return parsed
		} finally {
			attempts.delete(attempt)
		}
	}
}
/* oxlint-enable anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */

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
