/**
 * Convex's field-name rule (`validateObjectField` in convex/src/values/value.ts, which the backend
 * enforces at push): non-empty, at most 1024 characters, no leading '$', printable ASCII only. A
 * leading '_' is allowed in an object validator, as for `_id` and `_creationTime`.
 */
/**
 * Write an own data property. Field maps are built from dynamic keys, and `out[key] = …` with
 * `'__proto__'` would call the prototype setter instead of adding a field.
 */
export function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

export function isFieldName(key: string): boolean {
	if (key.length === 0 || key.length > 1024 || key.charCodeAt(0) === 36) return false
	for (let index = 0; index < key.length; index++) {
		const code = key.charCodeAt(index)
		if (code < 32 || code >= 127) return false
	}
	return true
}
