// Proves the v2 `k` tables keep v1's stored shape (R15, AE6): every fixture's exported table
// (document validator and indexes) equals the v1 snapshot, every derived boundary's input-side and
// output-side native validator equals it, and the executed observations agree. Every exception is
// listed below with its reason.
import type { GenericValidator } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'

import {
	attempt,
	exportTable,
	nativeSides,
	readV1Snapshot,
	type BoundarySides,
	type Outcome,
	type Snapshot,
} from './helpers'
import { declareTransformsTable, v2Fixtures } from './v2-fixtures'

type NativeSchema = {
	readonly validator: GenericValidator
	readonly outputValidator: GenericValidator
}

type AcceptedBehaviour = { readonly reason: string; readonly v2: Outcome }

type Fixture = (typeof v2Fixtures)[keyof typeof v2Fixtures]
type FixtureName = keyof typeof v2Fixtures

/**
 * Accepted boundary differences, by `fixture boundary side`. Kept to what the facts force.
 *
 * Not listed per entry, because it is one rule applied to every `tools.*` boundary: v1 tool masks
 * used `jsonSafeZid`, a plain string, so Zod's JSON Schema emitter would not see an opaque type;
 * v2 keeps `k.id(...)` (natively `v.id(table)`) because the `k` JSON Schema emitter renders an id
 * as a string. `withToolIdsAsStrings` applies exactly that rewrite before comparing tools.
 */
const ACCEPTED_BOUNDARY_DIFFERENCES = new Map([
	// `optionalThenDefault: .optional().default('o')`: the default is the outer step, so after a
	// parse the value is always present; v2's output side marks it required, Zod's kept it optional.
	// The input side (and so the stored validator) is identical.
	['defaults storage output', 'outer default is required on the output side'],
	['defaults schema output', 'outer default is required on the output side'],
	['defaults insertSchema output', 'outer default is required on the output side'],
])

/**
 * Accepted behaviour differences, by `fixture probe`, with v2's observed outcome. Each is a
 * documented v2 change (plan R9, R16, R17, U20 migration notes).
 */
const ACCEPTED_BEHAVIOUR_DIFFERENCES = new Map<string, AcceptedBehaviour>([
	[
		'scalars storage.parse intTop 1.5',
		{
			reason: 'same rejection; k names the issue not_integer where Zod said invalid_type',
			v2: { ok: false, error: [{ code: 'not_integer', path: [] }] },
		},
	],
	[
		'defaults updateSchema.parse {}',
		{
			reason:
				'v1 bug fixed: a patch no longer fills defaults, so it cannot overwrite stored values',
			v2: { ok: true, value: {} },
		},
	],
	[
		'checks toPublicDto re-applies trim',
		{
			reason: 'AE3: projection re-checks structure only; normalisers ran when the row was written',
			v2: { ok: true, value: { trimmed: '  x  ' } },
		},
	],
	[
		'strictness catchall parse unknown string key',
		{
			reason: 'k.object has no catchall; parse strips the unknown key instead of checking it',
			v2: { ok: true, value: { a: 'a' } },
		},
	],
	[
		'strictness catchall parse unknown number key',
		{
			reason: 'k.object has no catchall; parse strips the key Convex rejected on write',
			v2: { ok: true, value: { a: 'a' } },
		},
	],
	[
		'strictness toPublicDto nested unknown keys',
		{
			reason: 'R16: a projection that holds a key outside the public shape throws',
			v2: {
				ok: false,
				error: [
					{ code: 'unrecognized_keys', path: ['plain'] },
					{ code: 'unrecognized_keys', path: ['loose'] },
					{ code: 'unrecognized_keys', path: ['catchall'] },
				],
			},
		},
	],
])

const snapshot = readV1Snapshot()
const f = v2Fixtures
const row = { createdAt: 1, updatedAt: 2 }

// SAFETY (applies to every `as never` below): probes deliberately pass rows that the declared row
// type forbids, to observe v2's runtime handling of them, exactly as the v1 probes did.
const behaviours: Partial<Record<FixtureName, () => Record<string, Outcome>>> = {
	scalars: () => ({
		'storage.parse enumOne "only"': attempt(() => f.scalars.storage.shape.enumOne.parse('only')),
		'storage.parse intTop 1.5': attempt(() => f.scalars.storage.shape.intTop.parse(1.5)),
		'storage.parse intChecked 2^53': attempt(() =>
			f.scalars.storage.shape.intChecked.parse(2 ** 53),
		),
	}),
	modifiers: () => ({
		'optThenNullable null': attempt(() => f.modifiers.storage.shape.optThenNullable.parse(null)),
		'optThenNullable missing': attempt(() => f.modifiers.storage.pick('optThenNullable').parse({})),
		'nullableThenOpt null': attempt(() => f.modifiers.storage.shape.nullableThenOpt.parse(null)),
		'nullable missing': attempt(() => f.modifiers.storage.pick('nullable').parse({})),
	}),
	defaults: () => ({
		'insertSchema.parse omitting defaulted fields': attempt(() =>
			f.defaults.insertSchema.parse({ label: 'l', settings: { size: 1 } }),
		),
		'commandInput.parse omitting defaulted fields': attempt(() =>
			f.defaults.commandInput.parse({ label: 'l', settings: { size: 1 } }),
		),
		'updateSchema.parse {}': attempt(() => f.defaults.updateSchema.parse({})),
		'storage.parse row lacking defaulted fields': attempt(() =>
			f.defaults.storage.parse({ label: 'l', settings: { size: 1 } }),
		),
		'toPublicDto row lacking defaulted fields': attempt(() =>
			f.defaults.toPublicDto({ label: 'l', settings: { size: 1 } }),
		),
		'publicDto.parse explicit undefined status': attempt(() =>
			f.defaults.publicDto.parse({ label: 'l', status: undefined, settings: { size: 1 } }),
		),
	}),
	checks: () => ({
		'commandInput.parse trims and lowercases': attempt(() =>
			f.checks.commandInput.parse({ name: 'n', trimmed: '  x  ', lowered: 'ABC' }),
		),
		'commandInput.parse empty name (min 1)': attempt(() =>
			f.checks.commandInput.parse({ name: '', trimmed: 'x', lowered: 'a' }),
		),
		'toPublicDto re-applies trim': attempt(() =>
			// SAFETY: see the block comment above `behaviours`.
			f.checks.toPublicDto({ trimmed: '  x  ' } as never),
		),
		'storage.parse refine "blocked"': attempt(() =>
			f.checks.storage.shape.refined.parse('blocked'),
		),
	}),
	strictness: () => {
		const extra = { a: 'a', extra: 'e' }
		const columns = f.strictness.storage.shape
		return {
			'plain parse unknown string key': attempt(() => columns.plain.parse(extra)),
			'strict parse unknown string key': attempt(() => columns.strict.parse(extra)),
			'loose parse unknown string key': attempt(() => columns.loose.parse(extra)),
			'catchall parse unknown string key': attempt(() => columns.catchall.parse(extra)),
			'catchall parse unknown number key': attempt(() =>
				columns.catchall.parse({ a: 'a', extra: 1 }),
			),
			'toPublicDto nested unknown keys': attempt(() =>
				// SAFETY: see the block comment above `behaviours`.
				f.strictness.toPublicDto({
					plain: { a: 'a', extra: 'e' },
					strict: { a: 'a' },
					loose: { a: 'a', extra: 'e' },
					catchall: { a: 'a', extra: 1 },
				} as never),
			),
		}
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
		'commandInput.parse with server field': attempt(() =>
			f.masks.commandInput.parse({ title: 't', ownerId: 'u' }),
		),
		'insertSchema.parse with timestamp': attempt(() =>
			f.masks.insertSchema.parse({ title: 't', secret: 's', createdAt: 1 }),
		),
		'updateSchema.parse {}': attempt(() => f.masks.updateSchema.parse({})),
	}),
	tenant: () => ({
		'insertSchema.parse with tenant': attempt(() =>
			f.tenant.insertSchema.parse({ name: 'n', tenant: 't' }),
		),
		'storage.parse empty tenant': attempt(() => f.tenant.storage.parse({ name: 'n', tenant: '' })),
		'toPublicDto drops tenant': attempt(() =>
			f.tenant.toPublicDto({ name: 'n', tenant: 't', note: 'x' }),
		),
	}),
	variantLegacyUnion: () => ({
		'storage.parse default and loose key': attempt(() =>
			f.variantLegacyUnion.storage.parse({ kind: 'y', extra: 1 }),
		),
		'storage.parse plain object strips key': attempt(() =>
			f.variantLegacyUnion.storage.parse({ kind: 'x', x: 1, extra: 1 }),
		),
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
		'insertSchema.parse bank with server field': attempt(() =>
			f.variantBoundary.insertSchema.parse({ type: 'bank', iban: 'i', verified: true }),
		),
		'updateSchema.parse tag only': attempt(() =>
			f.variantBoundary.updateSchema.parse({ type: 'bank' }),
		),
		'commandInput.parse wallet': attempt(() =>
			f.variantBoundary.commandInput.parse({ type: 'wallet', provider: 'apple', holder: null }),
		),
	}),
	variantTimestamps: () => ({
		'insertSchema.parse with createdAt': attempt(() =>
			f.variantTimestamps.insertSchema.parse({ kind: 'note', text: 't', createdAt: 1 }),
		),
		'toPublicDto note with timestamps': attempt(() =>
			f.variantTimestamps.toPublicDto({ kind: 'note', text: 't', createdAt: 1, updatedAt: 2 }),
		),
	}),
	variantNoTimestamps: () => ({
		'insertSchema.parse own createdAt': attempt(() =>
			f.variantNoTimestamps.insertSchema.parse({ kind: 'event', at: 1, createdAt: 2 }),
		),
	}),
}

/** One call signature selects the `dto(true)` overload on every boundary kind. */
function dtoWithId(dto: (includeId: true) => NativeSchema): NativeSchema {
	return dto(true)
}

function boundariesOf(fixture: Fixture): [string, NativeSchema][] {
	const entries: [string, NativeSchema][] = [
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

function withToolIdsAsStrings(outcome: Outcome): Snapshot {
	return JSON.parse(
		JSON.stringify(outcome).replace(/\{"tableName":"[^"]*","type":"id"\}/g, '{"type":"string"}'),
	)
}

// SAFETY: the keys of v2Fixtures are exactly FixtureName.
const names = Object.keys(v2Fixtures) as FixtureName[]

describe('v2 table parity with the v1 snapshot', () => {
	it('declares every v1 fixture except the transforms one, which v2 rejects', () => {
		expect([...names, 'transforms'].sort()).toEqual(Object.keys(snapshot).sort())
		expect(() => declareTransformsTable()).toThrow(/"parsedNumber".*transform or pipe/)
	})

	it.each(names)('%s: exported table validator and indexes equal v1 (AE6)', (name) => {
		expect(v2Fixtures[name].tableName).toBe(snapshot[name].tableName)
		expect(exportTable(v2Fixtures[name].table)).toEqual(snapshot[name].table)
	})

	it.each(names)('%s: every boundary validator equals v1 on both sides', (name) => {
		const expected = snapshot[name].boundaries
		const actual = Object.fromEntries(
			boundariesOf(v2Fixtures[name]).map(([key, schema]) => [key, nativeSides(schema)]),
		)
		expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
		for (const [key, sides] of Object.entries(actual)) {
			for (const side of ['input', 'output'] as const) {
				const label = `${name} ${key} ${side}`
				const v1Side: BoundarySides[typeof side] = expected[key][side]
				if (ACCEPTED_BOUNDARY_DIFFERENCES.has(label)) {
					expect(sides[side], label).not.toEqual(v1Side)
					continue
				}
				const v2Side = key.startsWith('tools.') ? withToolIdsAsStrings(sides[side]) : sides[side]
				expect(v2Side, label).toEqual(v1Side)
			}
		}
	})

	it.each(names)('%s: executed behaviour agrees with v1 or is a listed v2 change', (name) => {
		const expected = snapshot[name].behaviour
		const actual = behaviours[name]?.() ?? {}
		expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
		for (const [probe, outcome] of Object.entries(actual)) {
			const label = `${name} ${probe}`
			const accepted = ACCEPTED_BEHAVIOUR_DIFFERENCES.get(label)
			if (accepted === undefined) expect(outcome, label).toEqual(expected[probe])
			else {
				expect(outcome, `${label}: ${accepted.reason}`).toEqual(accepted.v2)
				expect(outcome, label).not.toEqual(expected[probe])
			}
		}
	})

	it('lists no accepted difference that does not occur', () => {
		const labels = new Set<string>()
		for (const name of names) {
			for (const probe of Object.keys(snapshot[name].behaviour)) labels.add(`${name} ${probe}`)
			for (const key of Object.keys(snapshot[name].boundaries)) {
				labels.add(`${name} ${key} input`)
				labels.add(`${name} ${key} output`)
			}
		}
		for (const label of [
			...ACCEPTED_BOUNDARY_DIFFERENCES.keys(),
			...ACCEPTED_BEHAVIOUR_DIFFERENCES.keys(),
		])
			expect(labels.has(label), label).toBe(true)
	})
})
