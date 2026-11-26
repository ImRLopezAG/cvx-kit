import type { JSONValue } from 'convex/values'

/** Key-order-free encoding of native validator JSON (registry identities). */
export function canonicalNative(value: JSONValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalNative).join(',')}]`
	if (value !== null && Object(value) === value) {
		// SAFETY: native JSON contains only JSON objects, arrays and primitives.
		const object = value as { [key: string]: JSONValue }
		let encoded = '{'
		let separator = ''
		for (const key of Object.keys(object).sort()) {
			encoded += `${separator}${JSON.stringify(key)}:${canonicalNative(object[key])}`
			separator = ','
		}
		return `${encoded}}`
	}
	return JSON.stringify(value)
}

/** Exactly `canonicalNative(left) === canonicalNative(right)`, without building
 * either encoding: object keys compare as sets, primitives by their JSON text. */
export function sameNative(left: JSONValue, right: JSONValue): boolean {
	if (Array.isArray(left)) {
		if (!Array.isArray(right) || left.length !== right.length) return false
		for (let index = 0; index < left.length; index++)
			if (!sameNative(left[index], right[index])) return false
		return true
	}
	const leftObject = left !== null && Object(left) === left
	const rightObject = right !== null && Object(right) === right
	if (!leftObject || !rightObject || Array.isArray(right))
		return !leftObject && !rightObject && JSON.stringify(left) === JSON.stringify(right)
	// SAFETY: both sides are non-array JSON objects, checked above.
	const a = left as { [key: string]: JSONValue }
	// SAFETY: as above.
	const b = right as { [key: string]: JSONValue }
	const keys = Object.keys(a)
	if (keys.length !== Object.keys(b).length) return false
	for (const key of keys)
		if (!Object.prototype.propertyIsEnumerable.call(b, key) || !sameNative(a[key], b[key]))
			return false
	return true
}
