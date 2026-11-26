// Characterises what the v1 Zod table boundaries store and expose natively, so
// the v2 kTable family can be proven to produce the same stored shape (R15/U9).
//
// Converters, as v1 uses them:
// - table storage (`boundary.table`): the kit's `zodToConvex` (src/zod-convex.ts),
//   the INPUT-side conversion of `storage` passed to `defineTable`.
// - function args (src/zod-registration.ts): the kit's `zodToConvex` (input side).
// - function returns (src/zod-registration.ts): convex-helpers `zodOutputToConvex`.
// Both sides are recorded for every derived boundary below.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { zodOutputToConvex } from 'convex-helpers/server/zod4'
import { describe, expect, test } from 'vite-plus/test'
import { z } from 'zod'

import { zodToConvex } from '../../src/zod-table'
import { v1FixtureIntents, v1Fixtures } from './v1-fixtures'

const SNAPSHOT_FILE = new URL('./v1-tables.snapshot.json', import.meta.url)

type Snapshot = null | boolean | number | string | Snapshot[] | { [key: string]: Snapshot }
type Outcome = { ok: true; value: Snapshot } | { ok: false; error: Snapshot }
type ProbeRow = Record<string, Snapshot | bigint | undefined>

const UNDEFINED = '$undefined'

/** JSON with recursively sorted keys; bigint and undefined are tagged so they stay visible. */
function stableJson<Value>(value: Value): string {
	return JSON.stringify(
		value,
		(_key, current) => {
			if (current === undefined) return UNDEFINED
			if (z.bigint().safeParse(current).success) return `$bigint:${String(current)}`
			if (current instanceof Object && !Array.isArray(current))
				return Object.fromEntries(
					Object.entries(current).sort(([left], [right]) => (left < right ? -1 : 1)),
				)
			return current
		},
		'\t',
	)
}

function toSnapshot<Value>(value: Value): Snapshot {
	return z.json().parse(JSON.parse(stableJson(value)))
}

function describeError(cause: Error | string): Snapshot {
	if (cause instanceof z.ZodError)
		return cause.issues.map((issue) => toSnapshot({ code: issue.code, path: issue.path }))
	return cause instanceof Error ? cause.message : cause
}

function attempt<Result>(run: () => Result): Outcome {
	try {
		return { ok: true, value: toSnapshot(run()) }
	} catch (cause) {
		return { ok: false, error: describeError(cause instanceof Error ? cause : String(cause)) }
	}
}

function parse(schema: z.ZodType, input: ProbeRow | Snapshot): Outcome {
	return attempt(() => schema.parse(input))
}

const tableExportSchema = z.strictObject({
	documentType: z.json(),
	indexes: z.json(),
	searchIndexes: z.json(),
	vectorIndexes: z.json(),
	stagedDbIndexes: z.json(),
	stagedSearchIndexes: z.json(),
	stagedVectorIndexes: z.json(),
	stagedDocumentType: z.json().optional(),
})

type AnyTable = (typeof v1Fixtures)[keyof typeof v1Fixtures]['table']

/** `TableDefinition.export()` is what `defineSchema` sends to Convex; it is `@internal` in the types. */
function exportTable(table: AnyTable) {
	if (!('export' in table) || !(table.export instanceof Function))
		throw new Error('TableDefinition.export() is missing')
	return tableExportSchema.parse(table.export())
}

type NativeValidator = ReturnType<typeof zodOutputToConvex>

/** `Validator.json` is the wire form Convex stores; it is hidden from the public types. */
function validatorJson(validator: NativeValidator) {
	if (!('json' in validator)) throw new Error('Validator.json is missing')
	return z.json().parse(validator.json)
}

function native(schema: z.ZodType) {
	return {
		input: attempt(() => validatorJson(zodToConvex(schema))),
		output: attempt(() => validatorJson(zodOutputToConvex(schema))),
	}
}

type Fixture = (typeof v1Fixtures)[keyof typeof v1Fixtures]
type BoundaryEntry = readonly [name: string, schema: z.ZodType]

/** One call signature selects the `dto(true)` overload on every boundary kind. */
function dtoWithId(dto: (includeId: true) => z.ZodType) {
	return dto(true)
}

function boundariesOf(fixture: Fixture) {
	const entries: BoundaryEntry[] = [
		['storage', fixture.storage],
		['insertSchema', fixture.insertSchema],
	]
	if (!('schema' in fixture)) return entries
	entries.push(
		['schema', fixture.schema],
		['updateSchema', fixture.updateSchema],
		['commandInput', fixture.commandInput],
		['publicDto', fixture.publicDto],
		['dto(true)', dtoWithId(fixture.dto)],
		['tools.insert', fixture.tools.insert],
		['tools.update', fixture.tools.update],
		['tools.id', fixture.tools.id],
	)
	return entries
}

const f = v1Fixtures
const row = { createdAt: 1, updatedAt: 2 }

// SAFETY (applies to every `as never` below): probes deliberately pass rows that
// the declared row type forbids, to observe v1's runtime handling of them.
const behaviours: Partial<Record<keyof typeof v1Fixtures, () => Record<string, Outcome>>> = {
	scalars: () => ({
		'storage.parse enumOne "only"': attempt(() => f.scalars.storage.shape.enumOne.parse('only')),
		'storage.parse intTop 1.5': parse(f.scalars.storage.shape.intTop, 1.5),
		'storage.parse intChecked 2^53': parse(f.scalars.storage.shape.intChecked, 2 ** 53),
	}),
	modifiers: () => ({
		'optThenNullable null': parse(f.modifiers.storage.shape.optThenNullable, null),
		'optThenNullable missing': parse(f.modifiers.storage.pick({ optThenNullable: true }), {}),
		'nullableThenOpt null': parse(f.modifiers.storage.shape.nullableThenOpt, null),
		'nullable missing': parse(f.modifiers.storage.pick({ nullable: true }), {}),
	}),
	defaults: () => ({
		'insertSchema.parse omitting defaulted fields': parse(f.defaults.insertSchema, {
			label: 'l',
			settings: { size: 1 },
		}),
		'commandInput.parse omitting defaulted fields': parse(f.defaults.commandInput, {
			label: 'l',
			settings: { size: 1 },
		}),
		'updateSchema.parse {}': parse(f.defaults.updateSchema, {}),
		'storage.parse row lacking defaulted fields': parse(f.defaults.storage, {
			label: 'l',
			settings: { size: 1 },
		}),
		'toPublicDto row lacking defaulted fields': attempt(() =>
			// SAFETY: see the block comment above `behaviours`.
			f.defaults.toPublicDto({ label: 'l', settings: { size: 1 } } as never),
		),
		'publicDto.parse explicit undefined status': parse(f.defaults.publicDto, {
			label: 'l',
			status: undefined,
			settings: { size: 1 },
		}),
	}),
	checks: () => ({
		'commandInput.parse trims and lowercases': parse(f.checks.commandInput, {
			name: 'n',
			trimmed: '  x  ',
			lowered: 'ABC',
		}),
		'commandInput.parse empty name (min 1)': parse(f.checks.commandInput, {
			name: '',
			trimmed: 'x',
			lowered: 'a',
		}),
		'toPublicDto re-applies trim': attempt(() =>
			// SAFETY: see the block comment above `behaviours`.
			f.checks.toPublicDto({ trimmed: '  x  ' } as never),
		),
		'storage.parse refine "blocked"': parse(f.checks.storage.shape.refined, 'blocked'),
	}),
	transforms: () => ({
		'commandInput.parse transform and coerce': parse(f.transforms.commandInput, {
			parsedNumber: '42',
			coerced: '5',
		}),
		'toPublicDto re-runs transform': attempt(() =>
			// SAFETY: see the block comment above `behaviours`.
			f.transforms.toPublicDto({ parsedNumber: '42' } as never),
		),
		'toPublicDto on already transformed number': attempt(() =>
			// SAFETY: see the block comment above `behaviours`.
			f.transforms.toPublicDto({ parsedNumber: 42 } as never),
		),
	}),
	strictness: () => {
		const extra = { a: 'a', extra: 'e' }
		const results: Record<string, Outcome> = {}
		for (const key of ['plain', 'strict', 'loose', 'catchall'] as const) {
			results[`${key} parse unknown string key`] = parse(f.strictness.storage.shape[key], extra)
		}
		results['catchall parse unknown number key'] = parse(f.strictness.storage.shape.catchall, {
			a: 'a',
			extra: 1,
		})
		const nested = {
			plain: { a: 'a', extra: 'e' },
			strict: { a: 'a' },
			loose: { a: 'a', extra: 'e' },
			catchall: { a: 'a', extra: 1 },
		}
		// SAFETY: see the block comment above `behaviours`.
		results['toPublicDto nested unknown keys'] = attempt(() =>
			f.strictness.toPublicDto(nested as never),
		)
		return results
	},
	masks: () => ({
		'toPublicDto drops non-public fields': attempt(() =>
			// SAFETY: see the block comment above `behaviours`.
			f.masks.toPublicDto({
				...row,
				title: 't',
				ownerId: 'u',
				internalScore: 1,
				secret: 's',
			} as never),
		),
		'toPublicDto with _id': attempt(() =>
			f.masks.toPublicDto(
				// SAFETY: see the block comment above `behaviours`.
				{ ...row, title: 't', ownerId: 'u', internalScore: 1, secret: 's', _id: 'x' } as never,
				true,
			),
		),
		'toPublicDto row lacking required public field': attempt(() =>
			// SAFETY: see the block comment above `behaviours`.
			f.masks.toPublicDto({ ownerId: 'u' } as never),
		),
		'commandInput.parse with server field': parse(f.masks.commandInput, {
			title: 't',
			ownerId: 'u',
		}),
		'insertSchema.parse with timestamp': parse(f.masks.insertSchema, {
			title: 't',
			secret: 's',
			createdAt: 1,
		}),
		'updateSchema.parse {}': parse(f.masks.updateSchema, {}),
	}),
	tenant: () => ({
		'insertSchema.parse with tenant': parse(f.tenant.insertSchema, { name: 'n', tenant: 't' }),
		'storage.parse empty tenant': parse(f.tenant.storage, { name: 'n', tenant: '' }),
		'toPublicDto drops tenant': attempt(() =>
			f.tenant.toPublicDto({ name: 'n', tenant: 't', note: 'x' }),
		),
	}),
	variantLegacyUnion: () => ({
		'storage.parse default and loose key': parse(f.variantLegacyUnion.storage, {
			kind: 'y',
			extra: 1,
		}),
		'storage.parse plain object strips key': parse(f.variantLegacyUnion.storage, {
			kind: 'x',
			x: 1,
			extra: 1,
		}),
	}),
	variantBoundary: () => ({
		'toPublicDto card drops non-public fields': attempt(() =>
			f.variantBoundary.toPublicDto({ type: 'card', last4: '4242', brand: 'visa' }),
		),
		'toPublicDto card missing optional public field': attempt(() =>
			f.variantBoundary.toPublicDto({ type: 'card', last4: '4242' }),
		),
		'toPublicDto unknown tag': attempt(() =>
			// SAFETY: see the block comment above `behaviours`.
			f.variantBoundary.toPublicDto({ type: 'cash' } as never),
		),
		'insertSchema.parse bank with server field': parse(f.variantBoundary.insertSchema, {
			type: 'bank',
			iban: 'i',
			verified: true,
		}),
		'updateSchema.parse tag only': parse(f.variantBoundary.updateSchema, { type: 'bank' }),
		'commandInput.parse wallet': parse(f.variantBoundary.commandInput, {
			type: 'wallet',
			provider: 'apple',
			holder: null,
		}),
	}),
	variantTimestamps: () => ({
		'insertSchema.parse with createdAt': parse(f.variantTimestamps.insertSchema, {
			kind: 'note',
			text: 't',
			createdAt: 1,
		}),
		'toPublicDto note with timestamps': attempt(() =>
			f.variantTimestamps.toPublicDto({ kind: 'note', text: 't', createdAt: 1, updatedAt: 2 }),
		),
	}),
	variantNoTimestamps: () => ({
		'insertSchema.parse own createdAt': parse(f.variantNoTimestamps.insertSchema, {
			kind: 'event',
			at: 1,
			createdAt: 2,
		}),
	}),
}

function snapshotFixture(name: keyof typeof v1Fixtures) {
	const fixture = v1Fixtures[name]
	return {
		intent: v1FixtureIntents[name],
		tableName: fixture.tableName,
		table: exportTable(fixture.table),
		boundaries: Object.fromEntries(
			boundariesOf(fixture).map(([key, schema]) => [key, native(schema)]),
		),
		behaviour: behaviours[name]?.() ?? {},
	}
}

describe('v1 table parity snapshot', () => {
	test('stored shapes, derived validators and behaviour match the committed snapshot', async () => {
		const names = Object.keys(v1Fixtures).filter((key) => Object.hasOwn(v1FixtureIntents, key))
		expect(names).toHaveLength(Object.keys(v1Fixtures).length)
		const snapshot = Object.fromEntries(
			Object.entries(v1FixtureIntents).map(([name]) => [
				name,
				// SAFETY: keys come from v1FixtureIntents, which `satisfies` the fixture name record.
				snapshotFixture(name as keyof typeof v1Fixtures),
			]),
		)
		const actual = `${stableJson(snapshot)}\n`
		// Compare parsed JSON so `vp fmt` reflowing the committed file never fails the test.
		// `_updateSnapshot` is vitest's private mode flag; it is 'all' under `-u`.
		if (!existsSync(SNAPSHOT_FILE) || expect.getState().snapshotState['_updateSnapshot'] === 'all')
			writeFileSync(SNAPSHOT_FILE, actual)
		expect(JSON.parse(actual)).toEqual(JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')))
	})
})
