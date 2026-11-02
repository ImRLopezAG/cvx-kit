/** Retain both successful builds and configuration failures; never repeat declaration effects. */
export function memoize<Value>(build: () => Value): () => Value {
	let state: 'pending' | 'building' | 'ready' | 'failed' = 'pending'
	let value: Value
	let failure: unknown
	return () => {
		if (state === 'ready') return value
		if (state === 'failed') throw failure
		if (state === 'building') throw new Error('Recursive lazy declaration')
		state = 'building'
		try {
			value = build()
			state = 'ready'
			return value
		} catch (cause) {
			failure = cause
			state = 'failed'
			throw cause
		}
	}
}

const registryBuilders = new WeakMap<object, () => object>()

/** Internal bridge lets the architecture test path validate explicitly supplied registries. */
export function registerLazyRegistry<Registry extends object>(
	registry: Registry,
	build: () => object,
): Registry {
	registryBuilders.set(registry, build)
	return registry
}

export function forceRegistry<Registry extends object>(registry: Registry): void {
	const build = registryBuilders.get(registry)
	if (!build) throw new Error('Expected a kit Effect registry')
	build()
}
