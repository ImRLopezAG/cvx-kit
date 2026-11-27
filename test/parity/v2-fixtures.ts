// v2 (`k`) translations of the v1 parity fixtures the snapshot was recorded from (see README.md), one
// per table and in the same order. `z.object` and `.catchall(...)` become `k.object`, `z.strictObject` `k.strictObject` and
// `z.looseObject` `k.looseObject` (all four store the same closed object); `z.bigint` becomes `k.int64`; `z.unknown`
// becomes `k.any`; `nullish` becomes `.nullable().optional()`; `z.email` and `z.url` become string
// checks (checks never reach the stored validator). The v1 `transforms` fixture has no v2 table:
// v2 rejects transform and pipe fields at definition, which v2-parity.test.ts asserts instead.
import { k } from '../../src/k'
import { createTable, kTable, kVariantTable, tenantTable } from '../../src/table'

const scalars = kTable('p_scalars', {
	str: k.string(),
	num: k.number(),
	intChecked: k.number().int(),
	intTop: k.int(),
	bool: k.boolean(),
	nul: k.null(),
	litString: k.literal('fixed'),
	litNumber: k.literal(7),
	litBool: k.literal(true),
	enumOne: k.enum(['only']),
	enumMany: k.enum(['draft', 'active', 'closed']),
	big: k.int64(),
})

const ids = kTable('p_ids', {
	owner: k.id('users'),
	maybeOwner: k.id('users').optional(),
	members: k.array(k.id('users')),
	nullableRef: k.id('teams').nullable(),
})

const containers = kTable('p_containers', {
	tags: k.array(k.string()),
	lines: k.array(k.object({ sku: k.string(), qty: k.number(), ref: k.id('products').optional() })),
	address: k.object({ city: k.string(), geo: k.object({ lat: k.number(), lng: k.number() }) }),
	union: k.union([k.string(), k.number(), k.null()]),
	tagged: k.discriminatedUnion('kind', [
		k.object({ kind: k.literal('a'), a: k.string() }),
		k.object({ kind: k.literal('b'), b: k.number() }),
	]),
	counts: k.record(k.string(), k.number()),
	refsByKey: k.record(k.string(), k.id('users')),
})

const opaque = kTable('p_opaque', {
	anything: k.any(),
	unknownValue: k.any(),
	jsonValue: k.json(),
})

const modifiers = kTable('p_modifiers', {
	opt: k.string().optional(),
	nullable: k.string().nullable(),
	optThenNullable: k.string().optional().nullable(),
	nullableThenOpt: k.string().nullable().optional(),
	nullish: k.string().nullable().optional(),
	optionalObject: k.object({ a: k.string() }).optional(),
	optionalArray: k.array(k.number()).optional(),
})

const defaults = kTable(
	'p_defaults',
	{
		label: k.string(),
		status: k.enum(['draft', 'active']).default('draft'),
		count: k.number().default(0),
		title: k.string().default('untitled'),
		flags: k.array(k.string()).default([]),
		settings: k.object({ theme: k.string().default('light'), size: k.number() }),
		defaultThenOptional: k.string().default('d').optional(),
		optionalThenDefault: k.string().optional().default('o'),
	},
	{
		commandFields: ['label', 'status', 'count', 'settings'],
		publicFields: ['label', 'status', 'count', 'title', 'settings', 'defaultThenOptional'],
	},
)

const checks = kTable(
	'p_checks',
	{
		name: k.string().min(1).max(40),
		code: k.string().regex(/^[A-Z]{3}$/),
		trimmed: k.string().trim(),
		lowered: k.string().toLowerCase(),
		email: k.string().regex(/^[^@\s]+@[^@\s]+$/),
		qty: k.number().int().min(1),
		ratio: k.number().min(0).max(1),
		refined: k.string().refine((value) => value !== 'blocked'),
	},
	{ commandFields: ['name', 'trimmed', 'lowered'], publicFields: ['trimmed'] },
)

const strictness = kTable(
	'p_strictness',
	{
		plain: k.object({ a: k.string() }),
		strict: k.strictObject({ a: k.string() }),
		loose: k.looseObject({ a: k.string() }),
		catchall: k.object({ a: k.string() }),
	},
	{
		commandFields: ['plain', 'strict', 'loose', 'catchall'],
		publicFields: ['plain', 'strict', 'loose', 'catchall'],
	},
)

const masks = kTable(
	'p_masks',
	{
		title: k.string(),
		body: k.string().optional(),
		ownerId: k.id('users'),
		internalScore: k.number(),
		secret: k.string(),
	},
	{
		serverFields: ['ownerId', 'internalScore'],
		commandFields: ['title', 'body'],
		publicFields: ['title', 'body', 'ownerId', 'createdAt', 'updatedAt'],
	},
)

const noOptions = kTable('p_no_options', { value: k.string() })

const tenant = tenantTable(
	'p_tenant',
	{ name: k.string(), note: k.string().optional() },
	{ commandFields: ['name', 'note'], publicFields: ['name'] },
)

// v2 infers extra server fields; v1 needed explicit generics here.
const tenantPublic = tenantTable(
	'p_tenant_public',
	{ name: k.string(), approver: k.id('users') },
	{
		serverFields: ['approver'],
		commandFields: ['name'],
		publicFields: ['name', 'tenant', 'archivedAt'],
	},
)

const sharedTable = createTable({
	workspace: k.string().min(1),
	note: k.string().optional(),
})

const shared = sharedTable(
	'p_shared',
	{ amount: k.number(), memo: k.string().nullable() },
	{
		serverFields: ['workspace'],
		commandFields: ['note', 'amount', 'memo'],
		publicFields: ['workspace', 'amount'],
	},
)

const indexed = kTable('p_indexed', {
	ownerId: k.id('users'),
	title: k.string(),
	body: k.string(),
	status: k.enum(['open', 'done']),
	embedding: k.array(k.number()),
})
indexed.table
	.index('by_owner', ['ownerId'])
	.index('by_owner_archived', ['ownerId', 'archivedAt'])
	.searchIndex('search_body', { searchField: 'body', filterFields: ['ownerId', 'status'] })
	.vectorIndex('by_embedding', {
		vectorField: 'embedding',
		dimensions: 3,
		filterFields: ['status'],
	})

const tenantIndexed = tenantTable('p_tenant_indexed', { no: k.string() })
tenantIndexed.table.index('by_no', ['tenant', 'no'])

const variantBranches = k.discriminatedUnion('type', [
	k.object({ type: k.literal('card'), last4: k.string(), brand: k.string().optional() }),
	k.object({ type: k.literal('bank'), iban: k.string(), verified: k.boolean() }),
	k.object({
		type: k.literal('wallet'),
		provider: k.enum(['apple', 'google']),
		holder: k.string().nullable(),
	}),
])

const variantLegacyDiscriminated = kVariantTable('p_variant_legacy', variantBranches)

const variantLegacyUnion = kVariantTable(
	'p_variant_legacy_union',
	k.union([
		k.object({ kind: k.literal('x'), x: k.number() }),
		k.looseObject({ kind: k.literal('y'), y: k.string().default('y') }),
	]),
)

const variantBoundary = kVariantTable('p_variant_boundary', variantBranches, {
	discriminator: 'type',
	variants: {
		card: { commandFields: ['last4', 'brand'], publicFields: ['brand'] },
		bank: { serverFields: ['verified'], commandFields: ['iban'], publicFields: ['iban'] },
		wallet: { commandFields: ['provider', 'holder'], publicFields: ['provider'] },
	},
})

const variantTimestamps = kVariantTable(
	'p_variant_timestamps',
	k.discriminatedUnion('kind', [
		k.object({ kind: k.literal('note'), text: k.string() }),
		k.object({
			kind: k.literal('link'),
			url: k.string().regex(/^https?:\/\//),
			ownerId: k.string(),
		}),
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

const variantNoTimestamps = kVariantTable(
	'p_variant_no_timestamps',
	k.discriminatedUnion('kind', [
		k.object({ kind: k.literal('event'), at: k.number(), createdAt: k.number() }),
		k.object({ kind: k.literal('marker'), label: k.string() }),
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

/** Every v2 fixture, keyed like the v1 fixtures (`transforms` excepted, see the header). */
export const v2Fixtures = {
	scalars,
	ids,
	containers,
	opaque,
	modifiers,
	defaults,
	checks,
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

/** The v1 `transforms` fixture's fields: v2 must reject the table that declares them. */
export function declareTransformsTable() {
	return kTable(
		'p_transforms',
		{
			// @ts-expect-error a transform field is a type error as well as a definition-time error
			parsedNumber: k.string().transform(Number),
			// @ts-expect-error a pipe field is a type error as well as a definition-time error
			piped: k.string().pipe(k.string().min(1)),
		},
		{ commandFields: ['parsedNumber'], publicFields: ['parsedNumber'] },
	)
}
