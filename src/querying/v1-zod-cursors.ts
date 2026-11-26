/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Cursor transport and canonical values are explicit validation boundaries. */
// v1 bridge (U23 -> U18): the frozen Zod scoped cursor codec of src/querying/cursors.ts, moved
// verbatim so the v1 Zod files keep working while the engine layer is on `k`. The transport, key
// ring, binding and errors are the v2 module's own. Only v1 files import it; the cutover deletes it.
import type { Value } from 'convex/values'
import { z } from 'zod'
import { CursorError, scopedCursorCodec, type createCursorCodec } from './cursors'
import type { ManagedScope } from './security'

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
	let parse: (value: unknown) => z.output<S>
	try {
		parse = synchronousCursorParser(options.schema)
	} catch {
		throw new CursorError()
	}
	return scopedCursorCodec<z.input<S>, z.output<S>>(transport, scope, {
		domain: options.domain,
		bind: options.bind,
		parse,
	})
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
