import { setOwn } from './names'

/** Copy plain objects and arrays each time a default or catch value is filled. */
export function copyFill(value: any): any {
	if (Array.isArray(value)) return value.map(copyFill)
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- fills can contain primitives and opaque values, which keep their identity.
	if (value === null || typeof value !== 'object') return value
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return value
	// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- copying an already declared fill preserves arbitrary own values without decoding them.
	const out: Record<string, unknown> = {}
	for (const key of Object.keys(value)) setOwn(out, key, copyFill(value[key]))
	return out
}
