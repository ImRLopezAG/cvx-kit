/**
 * Convex's field-name rule (`validateObjectField` in convex/src/values/value.ts, which the backend
 * enforces at push): non-empty, at most 1024 characters, no leading '$', printable ASCII only. A
 * leading '_' is allowed in an object validator, as for `_id` and `_creationTime`.
 */
export function isFieldName(key: string): boolean {
	if (key.length === 0 || key.length > 1024 || key.charCodeAt(0) === 36) return false
	for (let index = 0; index < key.length; index++) {
		const code = key.charCodeAt(index)
		if (code < 32 || code >= 127) return false
	}
	return true
}
