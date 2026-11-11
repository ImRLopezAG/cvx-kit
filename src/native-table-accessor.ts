import type { TableDefinition } from 'convex/server'

/** Internal: getters that build a boundary's native table once, on first read. */
const trustedAccessors = new WeakSet<() => TableDefinition>()

/** Marks a boundary's memoized `table` getter as safe for relation registries to defer. */
export function trustNativeTableAccessor<Boundary extends object>(boundary: Boundary): Boundary {
	const getter = Object.getOwnPropertyDescriptor(boundary, 'table')?.get
	if (getter) trustedAccessors.add(getter)
	return boundary
}

/** True only for getters registered by the table boundary constructors. */
export function isLazyNativeTable(
	getter: (() => TableDefinition) | undefined,
): getter is () => TableDefinition {
	return getter !== undefined && trustedAccessors.has(getter)
}
