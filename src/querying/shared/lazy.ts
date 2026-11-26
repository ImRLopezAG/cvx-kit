import { z } from 'zod'
import { memoize } from '../../modules/contracts/lazy'

/**
 * A real `ZodOptional` whose inner schema builds on the first read of its
 * definition's `innerType`: parsing, `unwrap()`, Convex conversion or JSON
 * Schema output. Constructing it, placing it in an object shape, `.pick`,
 * `.extend` and copying the shape read none of that, so a module that only
 * declares the schema never builds it. Clones share the one memoized build;
 * a failed build rethrows on every later read.
 */
export function lazyOptional<T extends z.ZodType>(build: () => T): z.ZodOptional<T> {
	const inner = memoize(build)
	const definition = {
		type: 'optional' as const,
		get innerType() {
			return inner()
		},
	}
	// The getter keeps its identity when zod clones the definition, so clones stay recognizable.
	lazyAccessors.add(Object.getOwnPropertyDescriptor(definition, 'innerType')!.get!)
	// SAFETY: the definition is exactly `.optional()`'s, with its inner schema T read on demand.
	return new z.ZodOptional(definition) as z.ZodOptional<T>
}

type Accessor = () => z.ZodType
const lazyAccessors = new WeakSet<Accessor>()

/** True only for the accessor of a kit-built lazy definition; caller-owned getters stay untrusted. */
export function isLazyAccessor(get: PropertyDescriptor['get']): get is Accessor {
	return get !== undefined && lazyAccessors.has(get)
}
