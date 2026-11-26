// v1 (Zod-backed) table declarations pinned by the v2 parity snapshot (R15 / U9).
// Each fixture is small and named for the shape feature it exercises. Do not
// change a fixture without regenerating test/parity/v1-tables.snapshot.json
// from the v1 implementation.
import type { Zid } from 'convex-helpers/server/zod4'
import { z } from 'zod'

import { createTable, tenantTable, zodTable, zodVariantTable } from '../../src/zod-table'

const scalars = zodTable('p_scalars', () => ({
	str: z.string(),
	num: z.number(),
	intChecked: z.number().int(),
	intTop: z.int(),
	bool: z.boolean(),
	nul: z.null(),
	litString: z.literal('fixed'),
	litNumber: z.literal(7),
	litBool: z.literal(true),
	enumOne: z.enum(['only']),
	enumMany: z.enum(['draft', 'active', 'closed']),
	big: z.bigint(),
}))

const ids = zodTable('p_ids', (id) => ({
	owner: id('users'),
	maybeOwner: id('users').optional(),
	members: z.array(id('users')),
	nullableRef: id('teams').nullable(),
}))

const containers = zodTable('p_containers', (id) => ({
	tags: z.array(z.string()),
	lines: z.array(z.object({ sku: z.string(), qty: z.number(), ref: id('products').optional() })),
	address: z.object({ city: z.string(), geo: z.object({ lat: z.number(), lng: z.number() }) }),
	union: z.union([z.string(), z.number(), z.null()]),
	tagged: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('a'), a: z.string() }),
		z.object({ kind: z.literal('b'), b: z.number() }),
	]),
	counts: z.record(z.string(), z.number()),
	refsByKey: z.record(z.string(), id('users')),
}))

const opaque = zodTable('p_opaque', () => ({
	anything: z.any(),
	unknownValue: z.unknown(),
	jsonValue: z.json(),
}))

const modifiers = zodTable('p_modifiers', () => ({
	opt: z.string().optional(),
	nullable: z.string().nullable(),
	optThenNullable: z.string().optional().nullable(),
	nullableThenOpt: z.string().nullable().optional(),
	nullish: z.string().nullish(),
	optionalObject: z.object({ a: z.string() }).optional(),
	optionalArray: z.array(z.number()).optional(),
}))

const defaults = zodTable(
	'p_defaults',
	() => ({
		label: z.string(),
		status: z.enum(['draft', 'active']).default('draft'),
		count: z.number().default(0),
		title: z.string().default('untitled'),
		flags: z.array(z.string()).default([]),
		settings: z.object({ theme: z.string().default('light'), size: z.number() }),
		defaultThenOptional: z.string().default('d').optional(),
		optionalThenDefault: z.string().optional().default('o'),
	}),
	{
		commandFields: ['label', 'status', 'count', 'settings'],
		publicFields: ['label', 'status', 'count', 'title', 'settings', 'defaultThenOptional'],
	},
)

const checks = zodTable(
	'p_checks',
	() => ({
		name: z.string().min(1).max(40),
		code: z.string().regex(/^[A-Z]{3}$/),
		trimmed: z.string().trim(),
		lowered: z.string().toLowerCase(),
		email: z.email(),
		qty: z.number().int().positive(),
		ratio: z.number().min(0).max(1),
		refined: z.string().refine((value) => value !== 'blocked'),
	}),
	{ commandFields: ['name', 'trimmed', 'lowered'], publicFields: ['trimmed'] },
)

const transforms = zodTable(
	'p_transforms',
	() => ({
		parsedNumber: z.string().transform(Number),
		piped: z.string().pipe(z.string().min(1)),
		coerced: z.coerce.number(),
	}),
	{ commandFields: ['parsedNumber', 'coerced'], publicFields: ['parsedNumber'] },
)

const strictness = zodTable(
	'p_strictness',
	() => ({
		plain: z.object({ a: z.string() }),
		strict: z.strictObject({ a: z.string() }),
		loose: z.looseObject({ a: z.string() }),
		catchall: z.object({ a: z.string() }).catchall(z.number()),
	}),
	{
		commandFields: ['plain', 'strict', 'loose', 'catchall'],
		publicFields: ['plain', 'strict', 'loose', 'catchall'],
	},
)

const masks = zodTable(
	'p_masks',
	(id) => ({
		title: z.string(),
		body: z.string().optional(),
		ownerId: id('users'),
		internalScore: z.number(),
		secret: z.string(),
	}),
	{
		serverFields: ['ownerId', 'internalScore'],
		commandFields: ['title', 'body'],
		publicFields: ['title', 'body', 'ownerId', 'createdAt', 'updatedAt'],
	},
)

const noOptions = zodTable('p_no_options', () => ({ value: z.string() }))

const tenant = tenantTable('p_tenant', () => ({ name: z.string(), note: z.string().optional() }), {
	commandFields: ['name', 'note'],
	publicFields: ['name'],
})

// v1 cannot infer tenantTable's ServerFields (the option is typed as
// `(ServerFields[number] | 'tenant')[]`), so extra server fields need explicit generics.
const tenantPublic = tenantTable<
	'p_tenant_public',
	{ name: z.ZodString; approver: Zid<'users'> },
	readonly ['approver'],
	readonly ['name'],
	readonly ['name', 'tenant', 'archivedAt']
>('p_tenant_public', (id) => ({ name: z.string(), approver: id('users') }), {
	serverFields: ['approver'],
	commandFields: ['name'],
	publicFields: ['name', 'tenant', 'archivedAt'],
})

const sharedTable = createTable({
	workspace: z.string().min(1),
	note: z.string().optional(),
})

const shared = sharedTable(
	'p_shared',
	() => ({ amount: z.number(), memo: z.string().nullable() }),
	{
		serverFields: ['workspace'],
		commandFields: ['note', 'amount', 'memo'],
		publicFields: ['workspace', 'amount'],
	},
)

const indexed = zodTable('p_indexed', (id) => ({
	ownerId: id('users'),
	title: z.string(),
	body: z.string(),
	status: z.enum(['open', 'done']),
	embedding: z.array(z.number()),
}))
indexed.table
	.index('by_owner', ['ownerId'])
	.index('by_owner_archived', ['ownerId', 'archivedAt'])
	.searchIndex('search_body', { searchField: 'body', filterFields: ['ownerId', 'status'] })
	.vectorIndex('by_embedding', {
		vectorField: 'embedding',
		dimensions: 3,
		filterFields: ['status'],
	})

const tenantIndexed = tenantTable('p_tenant_indexed', () => ({ no: z.string() }))
tenantIndexed.table.index('by_no', ['tenant', 'no'])

const variantBranches = z.discriminatedUnion('type', [
	z.strictObject({ type: z.literal('card'), last4: z.string(), brand: z.string().optional() }),
	z.strictObject({ type: z.literal('bank'), iban: z.string(), verified: z.boolean() }),
	z.strictObject({
		type: z.literal('wallet'),
		provider: z.enum(['apple', 'google']),
		holder: z.string().nullable(),
	}),
])

const variantLegacyDiscriminated = zodVariantTable('p_variant_legacy', variantBranches)

const variantLegacyUnion = zodVariantTable(
	'p_variant_legacy_union',
	z.union([
		z.object({ kind: z.literal('x'), x: z.number() }),
		z.looseObject({ kind: z.literal('y'), y: z.string().default('y') }),
	]),
)

const variantBoundary = zodVariantTable('p_variant_boundary', variantBranches, {
	discriminator: 'type',
	variants: {
		card: { commandFields: ['last4', 'brand'], publicFields: ['brand'] },
		bank: { serverFields: ['verified'], commandFields: ['iban'], publicFields: ['iban'] },
		wallet: { commandFields: ['provider', 'holder'], publicFields: ['provider'] },
	},
})

const variantTimestamps = zodVariantTable(
	'p_variant_timestamps',
	z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('note'), text: z.string() }),
		z.strictObject({ kind: z.literal('link'), url: z.url(), ownerId: z.string() }),
	]),
	{
		discriminator: 'kind',
		timestamps: true,
		variants: {
			note: { commandFields: ['text'], publicFields: ['text', 'createdAt'] },
			link: {
				serverFields: ['ownerId'],
				commandFields: ['url'],
				publicFields: ['url', 'updatedAt'],
			},
		},
	},
)

const variantNoTimestamps = zodVariantTable(
	'p_variant_no_timestamps',
	z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('event'), at: z.number(), createdAt: z.number() }),
		z.strictObject({ kind: z.literal('marker'), label: z.string() }),
	]),
	{
		discriminator: 'kind',
		timestamps: false,
		variants: {
			event: { commandFields: ['at', 'createdAt'], publicFields: ['at', 'createdAt'] },
			marker: { commandFields: ['label'], publicFields: ['label'] },
		},
	},
)

variantTimestamps.table.index('by_kind', ['kind'])

/** Every v1 fixture, keyed by a stable name used as the snapshot key. */
export const v1Fixtures = {
	scalars,
	ids,
	containers,
	opaque,
	modifiers,
	defaults,
	checks,
	transforms,
	strictness,
	masks,
	noOptions,
	tenant,
	tenantPublic,
	shared,
	indexed,
	tenantIndexed,
	variantLegacyDiscriminated,
	variantLegacyUnion,
	variantBoundary,
	variantTimestamps,
	variantNoTimestamps,
}

export type V1FixtureName = keyof typeof v1Fixtures

/** Plain-language intent of each fixture, copied into the snapshot. */
export const v1FixtureIntents = {
	scalars:
		'zodTable scalars: string, number, int (two spellings), boolean, null, literals, enum of one and many values, bigint',
	ids: 'zid fields: required, optional, array of ids, nullable id',
	containers:
		'arrays (strings, objects with optional id), nested objects, union, discriminated union field, string-keyed records',
	opaque: 'z.any, z.unknown and z.json fields',
	modifiers:
		'optional, nullable, optional().nullable(), nullable().optional(), nullish, optional object and array',
	defaults:
		'defaults on scalar, enum, array and nested object field, default().optional(), optional().default(); defaulted fields in command and public masks',
	checks:
		'string and number checks (min/max/regex/trim/toLowerCase/email/int/positive/refine) must not change the stored validator',
	transforms: 'transform, pipe and coerce: input and output converters diverge',
	strictness: 'z.object, z.strictObject, z.looseObject and catchall nested fields',
	masks: 'serverFields, commandFields and publicFields including timestamp fields',
	noOptions: 'zodTable with no options: empty command and public masks',
	tenant: 'tenantTable: injected server-owned tenant field',
	tenantPublic: 'tenantTable exposing tenant and archivedAt publicly with an extra server field',
	shared: 'createTable shared fields merged ahead of table fields',
	indexed: 'zodTable with chained index, searchIndex and vectorIndex on .table',
	tenantIndexed: 'tenantTable with an index over the injected tenant field',
	variantLegacyDiscriminated:
		'zodVariantTable legacy mode (no options) over a strict discriminated union',
	variantLegacyUnion:
		'zodVariantTable legacy mode over a plain z.union of non-strict objects with a default',
	variantBoundary:
		'zodVariantTable boundary mode, timestamps omitted, three branches with per-branch masks',
	variantTimestamps:
		'zodVariantTable boundary mode with timestamps: true, timestamp public fields and an index',
	variantNoTimestamps:
		'zodVariantTable boundary mode with timestamps: false, branch declares its own createdAt',
} satisfies Record<V1FixtureName, string>
