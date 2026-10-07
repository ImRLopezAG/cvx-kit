/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Canonical transport and retained receipts are explicit untrusted value boundaries. */
import { convexToJson, type Value, type JSONValue } from 'convex/values'
import type { ContractInput, ContractOutput, NeutralSchema } from './contract'

export type IdempotencyErrorCode =
	| 'unsupported-binding'
	| 'invalid-input'
	| 'corrupt'
	| 'ambiguous'
	| 'pending'
	| 'stale'
	| 'conflict'
export class IdempotencyError extends Error {
	readonly _tag = 'IdempotencyError'
	constructor(
		readonly code: IdempotencyErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'IdempotencyError'
	}
}
export interface IdempotencyIdentity {
	readonly operation: string
	/** Stable trusted tenant/principal or delegated-capability scope, supplied by the host. */
	readonly scope: string
	readonly key: string
}
export interface IdempotencyVersions {
	readonly operation: string
	readonly contract: string
	readonly binding: string
	readonly fingerprintPolicy: string
}
export interface IdempotencyReceipt {
	readonly versions: IdempotencyVersions
	readonly fingerprint: string
	readonly state: 'pending' | 'completed'
	readonly result?: unknown
}
export interface CanonicalConvexBounds {
	readonly maxDepth: number
	readonly maxNodes: number
	readonly maxBytes: number
	readonly maxArrayLength: number
	readonly maxObjectFields: number
}

const encoder = new TextEncoder()
/** Bounded transport encoding, using the pinned Convex integer/binary/float representation. */
export function canonicalConvexBytes(value: unknown, bounds: CanonicalConvexBounds): string {
	for (const bound of [
		bounds.maxDepth,
		bounds.maxNodes,
		bounds.maxBytes,
		bounds.maxArrayLength,
		bounds.maxObjectFields,
	])
		if (!Number.isSafeInteger(bound) || bound < 1)
			invalid('Canonical bounds must be positive safe integers')
	const ancestors = new Set<object>()
	let nodes = 0
	let bytes = 0
	function spend(amount: number) {
		bytes += amount
		if (bytes > bounds.maxBytes) invalid('Canonical input exceeds byte bound')
	}
	function textBytes(text: string) {
		if (text.length > bounds.maxBytes) invalid('Canonical input exceeds byte bound')
		return encoder.encode(text).length
	}
	function visit(current: unknown, depth: number): void {
		if (++nodes > bounds.maxNodes || depth > bounds.maxDepth)
			invalid('Canonical input exceeds traversal bound')
		if (current === null || typeof current === 'boolean') {
			spend(1)
			return
		}
		if (typeof current === 'number') {
			spend(9)
			return
		}
		if (typeof current === 'bigint') {
			if (current < -(1n << 63n) || current > (1n << 63n) - 1n)
				invalid('Convex integer exceeds signed int64')
			spend(9)
			return
		}
		if (typeof current === 'string') {
			spend(2 + textBytes(current))
			return
		}
		if (current instanceof ArrayBuffer) {
			spend(2 + current.byteLength)
			return
		}
		if (typeof current !== 'object') invalid('Unsupported canonical Convex value')
		if (ancestors.has(current)) invalid('Cyclic canonical input')
		ancestors.add(current)
		try {
			if (Array.isArray(current)) {
				if (current.length > bounds.maxArrayLength) invalid('Canonical array exceeds length bound')
				spend(2)
				for (const item of current) visit(item, depth + 1)
				return
			}
			const prototype = Object.getPrototypeOf(current)
			if (prototype !== Object.prototype && prototype !== null)
				invalid('Canonical input requires plain objects')
			if (Object.getOwnPropertySymbols(current).length) invalid('Unsupported canonical symbol keys')
			const keys = Object.keys(current)
			if (keys.length > bounds.maxObjectFields) invalid('Canonical object exceeds field bound')
			spend(2)
			for (const key of keys) {
				if (key.length > 1024 || key.startsWith('$') || /[^\x20-\x7e]/.test(key))
					invalid('Invalid Convex object key')
				const descriptor = Object.getOwnPropertyDescriptor(current, key)!
				if (!('value' in descriptor)) invalid('Canonical input cannot contain accessors')
				if (descriptor.value === undefined) continue
				spend(textBytes(key) + 1)
				visit(descriptor.value, depth + 1)
			}
		} finally {
			ancestors.delete(current)
		}
	}
	visit(value, 0)
	// Object projection retains own __proto__ keys which the SDK's assignment-based object converter drops.
	// Scalars still use the pinned SDK's exact integer/binary/float representation.
	function project(current: Value): JSONValue {
		if (Array.isArray(current)) return current.map(project)
		if (current !== null && typeof current === 'object' && !(current instanceof ArrayBuffer)) {
			const output: Record<string, JSONValue> = Object.create(null)
			for (const key of Object.keys(current).sort()) {
				// SAFETY: prior bounded traversal excluded every object type except plain Convex dictionaries.
				const item = (current as Record<string, Value | undefined>)[key]
				if (item !== undefined) output[key] = project(item)
			}
			return output
		}
		return convexToJson(current)
	}
	// SAFETY: the traversal validates the bounded supported Convex value subset before SDK conversion.
	const encoded = JSON.stringify(project(value as Value))
	if (encoder.encode(encoded).length > bounds.maxBytes)
		invalid('Canonical encoding exceeds byte bound')
	return encoded
}

const versionFields = ['operation', 'contract', 'binding', 'fingerprintPolicy'] as const
const invocationBytes: unique symbol = Symbol('idempotency invocation bytes')
export interface IdempotencyInvocation {
	readonly identity: IdempotencyIdentity
	readonly versions: IdempotencyVersions
	readonly [invocationBytes]: string
}
export interface IdempotencyCapture {
	readonly binding: { readonly kind: 'mutation'; readonly atomicity: 'same-mutation' }
	readonly identity: IdempotencyIdentity
	readonly versions: IdempotencyVersions
	readonly rawInput: unknown
	readonly canonical: {
		readonly bounds: CanonicalConvexBounds
		/** Explicit deterministic equivalence; the host versions this policy in fingerprintPolicy. */
		// oxlint-disable-next-line anti-slop/no-unknown-returns -- The explicit normalized transport policy is validated by canonicalConvexBytes before capture.
		readonly normalize?: (raw: unknown) => unknown
	}
}
/** Call at the trusted native handler before domain decoding, once per invocation (including nested calls). */
export function captureIdempotencyInvocation(capture: IdempotencyCapture): IdempotencyInvocation {
	if (capture.binding.kind !== 'mutation' || capture.binding.atomicity !== 'same-mutation')
		throw new IdempotencyError(
			'unsupported-binding',
			'Idempotency requires the current native mutation transaction',
		)
	const identity = Object.freeze({
		operation: capture.identity.operation,
		scope: capture.identity.scope,
		key: capture.identity.key,
	})
	const versions = Object.freeze({
		operation: capture.versions.operation,
		contract: capture.versions.contract,
		binding: capture.versions.binding,
		fingerprintPolicy: capture.versions.fingerprintPolicy,
	})
	if (!validIdentity(identity) || !validVersions(versions))
		invalid('Invalid trusted idempotency metadata')
	const bytes = canonicalConvexBytes(
		capture.canonical.normalize ? capture.canonical.normalize(capture.rawInput) : capture.rawInput,
		capture.canonical.bounds,
	)
	return Object.freeze({ identity, versions, [invocationBytes]: bytes })
}
/** Shared protocol checks have no Effect dependency and never decode final wire data. */
export function retainedIdempotencyReceipt(
	rows: readonly unknown[],
	invocation: IdempotencyInvocation,
): IdempotencyReceipt | undefined {
	if (!Array.isArray(rows)) throw new IdempotencyError('corrupt', 'Receipt lookup must return rows')
	if (rows.length > 1)
		throw new IdempotencyError('ambiguous', 'Multiple receipts match the stable identity')
	if (rows.length === 0) return undefined
	const receipt = rows[0]
	if (
		typeof receipt !== 'object' ||
		receipt === null ||
		!Object.hasOwn(receipt, 'versions') ||
		!Object.hasOwn(receipt, 'fingerprint') ||
		!Object.hasOwn(receipt, 'state')
	)
		throw new IdempotencyError('corrupt', 'Malformed retained receipt')
	// SAFETY: this temporary retained-row view is fully checked below before returning or using metadata.
	const candidate = receipt as IdempotencyReceipt
	if (
		!validVersions(candidate.versions) ||
		typeof candidate.fingerprint !== 'string' ||
		!['pending', 'completed'].includes(candidate.state) ||
		(candidate.state === 'completed' && !Object.hasOwn(candidate, 'result'))
	)
		throw new IdempotencyError('corrupt', 'Malformed retained receipt')
	if (versionFields.some((key) => candidate.versions[key] !== invocation.versions[key]))
		throw new IdempotencyError(
			'stale',
			'Retained receipt version differs from the current operation',
		)
	if (candidate.state === 'pending')
		throw new IdempotencyError('pending', 'Retained receipt is incomplete')
	return candidate
}
export function idempotencyCanonicalInput(invocation: IdempotencyInvocation): string {
	if (!Object.hasOwn(invocation, invocationBytes))
		throw new IdempotencyError('unsupported-binding', 'Missing trusted invocation capture')
	return invocation[invocationBytes]
}
export function idempotencyFingerprint(value: string, receipt?: IdempotencyReceipt): string {
	if (typeof value !== 'string' || value.length === 0)
		throw new IdempotencyError('invalid-input', 'Fingerprint policy must return a nonempty string')
	if (receipt && receipt.fingerprint !== value)
		throw new IdempotencyError('conflict', 'Caller key was already used with different input')
	return value
}
export type IdempotencyPreparation<Result> =
	| { readonly kind: 'replay'; readonly result: unknown }
	| { readonly kind: 'execute'; readonly complete: (result: Result) => Promise<void> }
type NeutralValue<A> = A | PromiseLike<A>
/** Host callbacks close over the same secured mutation writer; native OCC/rollback remains host-owned. */
export function transactionalIdempotency<const Replay extends NeutralSchema, Claim>(configuration: {
	readonly final: {
		readonly replayResult: Replay
		readonly encode: (result: ContractOutput<Replay>) => NeutralValue<ContractInput<Replay>>
	}
	readonly authorize: (invocation: IdempotencyInvocation) => NeutralValue<void>
	readonly lookup: (identity: IdempotencyIdentity) => NeutralValue<readonly unknown[]>
	readonly fingerprint: (canonicalBytes: string) => NeutralValue<string>
	readonly claim: (
		identity: IdempotencyIdentity,
		receipt: IdempotencyReceipt,
	) => NeutralValue<Claim>
	readonly complete: (claim: Claim, receipt: IdempotencyReceipt) => NeutralValue<void>
}) {
	return {
		replayResult: configuration.final.replayResult,
		async prepare(
			invocation: IdempotencyInvocation,
		): Promise<IdempotencyPreparation<ContractOutput<Replay>>> {
			const canonical = idempotencyCanonicalInput(invocation)
			await configuration.authorize(invocation)
			const retained = retainedIdempotencyReceipt(
				await configuration.lookup(invocation.identity),
				invocation,
			)
			const fingerprint = idempotencyFingerprint(
				await configuration.fingerprint(canonical),
				retained,
			)
			if (retained) return { kind: 'replay', result: retained.result }
			const claim = await configuration.claim(invocation.identity, {
				state: 'pending',
				versions: invocation.versions,
				fingerprint,
			})
			return {
				kind: 'execute',
				complete: async (result) => {
					const wire = await configuration.final.encode(result)
					await configuration.complete(claim, {
						state: 'completed',
						versions: invocation.versions,
						fingerprint,
						result: wire,
					})
				},
			}
		},
	}
}

function invalid(message: string): never {
	throw new IdempotencyError('invalid-input', message)
}
function validIdentity(value: IdempotencyIdentity): boolean {
	return [value.operation, value.scope, value.key].every(
		(field) => typeof field === 'string' && field.length > 0,
	)
}
function validVersions(value: unknown): value is IdempotencyVersions {
	if (typeof value !== 'object' || value === null) return false
	// SAFETY: this temporary metadata view is checked field by field before the predicate certifies it.
	const candidate = value as Partial<IdempotencyVersions>
	return versionFields.every((field) => {
		const item = candidate[field]
		return Object.hasOwn(candidate, field) && typeof item === 'string' && item.length > 0
	})
}
