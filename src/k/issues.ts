import { ConvexError } from 'convex/values'
import type { KPath } from './types'

export type KIssueCode =
	| 'invalid_type'
	| 'too_small'
	| 'too_big'
	| 'invalid_format'
	| 'not_integer'
	| 'invalid_value'
	| 'unrecognized_key'
	| 'invalid_union'
	| 'custom'

/** One validation failure. A type alias, not an interface, so it is a Convex `Value` and crosses the wire. */
export type KIssue = { path: KPath; code: KIssueCode; message: string }

/** An issue added from `.check()`; its path is relative to the checked value. */
export type KIssueInput = {
	readonly path?: KPath
	readonly message: string
	readonly code?: KIssueCode
}

/**
 * `k.NEVER`, Zod's `z.NEVER`: what a transform returns after `context.addIssue(...)` when it has no
 * value. Typed `never`, so it fits any output type. Returned without an issue, the parse fails with
 * `Invalid input`.
 */
// SAFETY: a sentinel the walker recognises by identity; it is never handed out as a parsed value.
export const NEVER: never = Object.freeze({ k: 'never' }) as never

export type KValidationData = { code: 'VALIDATION'; issues: KIssue[] }

export type KSafeParseResult<T> =
	| { readonly success: true; readonly data: T }
	| { readonly success: false; readonly issues: KIssue[] }

/** Thrown by `parse` and the function boundary: a `ConvexError` whose data is `{ code: 'VALIDATION', issues }`. */
export class KValidationError extends ConvexError<KValidationData> {
	/**
	 * Kit boundaries omit stack frames: a validation failure is an expected outcome whose issues carry the
	 * path, and frames from the kit's walker (`k/parse.ts`, `registration.ts`) only made a dev
	 * backend's log read like a crash. Effect's `SchemaError` does the same. Other errors keep their stack.
	 */
	constructor(issues: KIssue[], boundary = true) {
		const limit = v8Error.stackTraceLimit
		if (boundary) v8Error.stackTraceLimit = 0
		try {
			super({ code: 'VALIDATION', issues })
		} finally {
			v8Error.stackTraceLimit = limit
		}
		this.name = 'KValidationError'
	}
}

/**
 * `Error` with V8's `stackTraceLimit`, typed here so `src/k` typechecks without Node's typings (it is
 * bundled for Convex's runtime). Writing it where the runtime lacks it is harmless.
 */
const v8Error: { stackTraceLimit?: number; readonly prototype: Error } = Error
