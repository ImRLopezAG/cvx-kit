// Zod-free helpers for comparing v2 tables with the v1 parity snapshot. The JSON normalisation is the
// one v1-snapshot.test.ts writes: keys sorted, `undefined` as "$undefined", a bigint as "$bigint:<n>".
import { readFileSync } from 'node:fs'
import type { TableDefinition } from 'convex/server'
import type { GenericValidator, ValidatorJSON } from 'convex/values'

import { k, KValidationError } from '../../src/k'

export type Snapshot = null | boolean | number | string | Snapshot[] | { [key: string]: Snapshot }

/** One executed observation, as the snapshot records it. */
export type Outcome = { ok: true; value: Snapshot } | { ok: false; error: Snapshot }

export type BoundarySides = { input: Outcome; output: Outcome }

export type FixtureSnapshot = {
	intent: string
	tableName: string
	table: Snapshot
	boundaries: Record<string, BoundarySides>
	behaviour: Record<string, Outcome>
}

const UNDEFINED = '$undefined'

/** Parsed v1 snapshot, keyed by fixture name. */
export function readV1Snapshot(): Record<string, FixtureSnapshot> {
	return JSON.parse(readFileSync(new URL('./v1-tables.snapshot.json', import.meta.url), 'utf8'))
}

/** The snapshot's JSON form of any value: sorted keys, tagged `undefined` and bigint. */
export function toSnapshot<Value>(value: Value): Snapshot {
	return JSON.parse(
		JSON.stringify(value, (_key, current) => {
			if (current === undefined) return UNDEFINED
			if (k.int64().safeParse(current).success) return `$bigint:${String(current)}`
			if (current instanceof Object && !Array.isArray(current))
				return Object.fromEntries(
					Object.entries(current).sort(([left], [right]) => (left < right ? -1 : 1)),
				)
			return current
		}),
	)
}

/**
 * Run a probe and record it as v1 did: a value, or the issues as `{ code, path }`. A k issue is
 * mapped to v1's vocabulary where only the spelling differs: k reports one `unrecognized_key` issue
 * at each unknown key, Zod one `unrecognized_keys` issue at the object holding them.
 */
export function attempt<Result>(run: () => Result): Outcome {
	try {
		return { ok: true, value: toSnapshot(run()) }
	} catch (cause) {
		if (cause instanceof KValidationError)
			return {
				ok: false,
				error: cause.data.issues.map((issue) =>
					issue.code === 'unrecognized_key'
						? { code: 'unrecognized_keys', path: toSnapshot(issue.path.slice(0, -1)) }
						: { code: issue.code, path: toSnapshot(issue.path) },
				),
			}
		return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
	}
}

/** `Validator.json` is the wire form Convex stores; it is hidden from the public types. */
export function validatorJson(validator: GenericValidator): Snapshot {
	// SAFETY: every Convex validator exposes its JSON form at runtime; the declarations mark it internal.
	return toSnapshot((validator as GenericValidator & { readonly json: ValidatorJSON }).json)
}

/** `TableDefinition.export()` is what `defineSchema` sends to Convex; it is `@internal` in the types. */
export function exportTable(table: TableDefinition): Snapshot {
	if (!('export' in table) || !(table.export instanceof Function))
		throw new Error('TableDefinition.export() is missing')
	return toSnapshot(table.export())
}

/** Both sides of a boundary, as the snapshot records them. */
export function nativeSides(schema: {
	readonly validator: GenericValidator
	readonly outputValidator: GenericValidator
}): BoundarySides {
	return {
		input: attempt(() => validatorJson(schema.validator)),
		output: attempt(() => validatorJson(schema.outputValidator)),
	}
}
