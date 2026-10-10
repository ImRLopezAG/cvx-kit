/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Configuration boundary validates heterogeneous own-key records and callback presence; validators remain opaque identities. */
import type { DomainContract } from './domain'

// SAFETY: this configuration boundary compares opaque fields or restores callback slots checked by the public helpers.
const protectedFields = ['input', 'result', 'classification', 'replayResult', 'wire'] as const
const bindings = new WeakMap<object, { key: string; declaration: object }>()

/** Both adapters bind declarations through the same configuration boundary. */
export function domainHelpers(entries: Readonly<Record<string, object>>) {
	return Object.fromEntries(
		Object.keys(entries).map((key) => [
			key,
			(implementation: object) => bindDomainImplementation(key, entries[key], implementation),
		]),
	)
}

/** Bind only opaque schema references; never invoke user callbacks at construction. */
export function bindDomainImplementation(key: string, declaration: object, implementation: object) {
	for (const field of ['handler', 'audit', 'prepare', 'guard', 'middleware', 'context']) {
		if (Object.prototype.hasOwnProperty.call(declaration, field))
			throw Error(`Domain contract ${key} cannot contain ${field}`)
	}
	for (const field of protectedFields) {
		if (Object.prototype.hasOwnProperty.call(implementation, field))
			throw Error(`Contracted operation ${key} cannot override ${field}`)
	}
	const definition = { ...implementation, ...declaration }
	bindings.set(definition, { key, declaration })
	return definition
}

/** Snapshot records and verify key ownership before the executor closes over them. */
export function snapshotOperations(
	operations: Readonly<Record<string, object>>,
	contract: DomainContract | undefined,
	section: 'commands' | 'queries',
	audit?: (resolution: never, context: never) => unknown,
) {
	if (audit !== undefined && typeof audit !== 'function')
		throw Error('Invalid registry audit callback')
	const declarations = contract?.[section]
	if (contract && !declarations) throw Error(`Domain contract has no ${section} section`)
	const keys = Object.keys(operations)
	if (
		declarations &&
		(keys.length !== Object.keys(declarations).length ||
			keys.some((key) => !Object.prototype.hasOwnProperty.call(declarations, key)))
	)
		throw Error('Contract operation keys must match exactly')
	const entries = keys.map((key) => {
		const original = operations[key]
		if (declarations) {
			const binding = bindings.get(original)
			if (
				!binding ||
				binding.key !== key ||
				binding.declaration !== declarations[key] ||
				protectedFields.some(
					(field) =>
						// SAFETY: this configuration boundary compares opaque fields or restores callback slots checked by the public helpers.
						(original as Record<string, unknown>)[field] !==
						// SAFETY: this configuration boundary compares opaque fields or restores callback slots checked by the public helpers.
						(declarations[key] as Record<string, unknown>)[field],
				)
			)
				throw Error(`Operation ${key} must use its own contract helper`)
		}
		// SAFETY: this configuration boundary compares opaque fields or restores callback slots checked by the public helpers.
		const definition = { ...original } as Record<string, unknown>
		if (definition.wire) {
			// SAFETY: wire is configuration, while its schema stays an opaque reference.
			definition.wire = Object.freeze({ ...(definition.wire as object) })
		}
		if (section === 'commands') {
			const override = definition.audit
			if (override !== undefined && typeof override !== 'function')
				throw Error(`Invalid audit for ${key}`)
			if (override === undefined) {
				if (!audit) throw Error(`Command ${key} requires an audit callback`)
				definition.audit = (resolution: { command: unknown; result: unknown }, context: unknown) =>
					audit(
						// SAFETY: this configuration boundary compares opaque fields or restores callback slots checked by the public helpers.
						{ operation: key, input: resolution.command, result: resolution.result } as never,
						// SAFETY: this configuration boundary compares opaque fields or restores callback slots checked by the public helpers.
						context as never,
					)
			}
		}
		// SAFETY: this configuration boundary compares opaque fields or restores callback slots checked by the public helpers.
		return [key, Object.freeze(definition)] as const
	})
	return Object.freeze(Object.fromEntries(entries))
}
