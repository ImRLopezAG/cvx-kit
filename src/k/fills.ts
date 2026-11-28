import { setOwn } from './names'

/** Copy plain objects and arrays each time a default or catch value is filled. */
export function copyFill(value: any, seen = new WeakMap<object, unknown>()): any {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- fills can contain primitives and opaque values, which keep their identity.
	if (value === null || typeof value !== 'object') return value
	const prototype = Object.getPrototypeOf(value)
	const array = Array.isArray(value)
	if (!array && prototype !== Object.prototype && prototype !== null) return value
	// A value that contains itself is copied once, so the copy keeps the cycle.
	if (seen.has(value)) return seen.get(value)
	if (array) {
		const items: unknown[] = []
		seen.set(value, items)
		for (const item of value) items.push(copyFill(item, seen))
		return items
	}
	// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- copying an already declared fill preserves arbitrary own values without decoding them.
	const out: Record<string, unknown> = {}
	seen.set(value, out)
	for (const key of Object.keys(value)) setOwn(out, key, copyFill(value[key], seen))
	return out
}
