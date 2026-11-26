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

export type KValidationData = { code: 'VALIDATION'; issues: KIssue[] }

export type KSafeParseResult<T> =
	| { readonly success: true; readonly data: T }
	| { readonly success: false; readonly issues: KIssue[] }

/** Thrown by `parse` and the function boundary: a `ConvexError` whose data is `{ code: 'VALIDATION', issues }`. */
export class KValidationError extends ConvexError<KValidationData> {
	constructor(issues: KIssue[]) {
		super({ code: 'VALIDATION', issues })
	}
}
