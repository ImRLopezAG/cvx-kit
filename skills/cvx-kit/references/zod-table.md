# `cvx-kit/zod-table` — one zod shape per entity, masked into every boundary

The core idea: an entity's shape is declared **once** as a zod object, and every
boundary that shape crosses — storage, insert, update, command input, public
DTO, LLM tool input — is a _derived mask_ of that single declaration. There is
no second source of truth to drift.

```ts
import { z } from 'zod'
import { zodTable } from 'cvx-kit/zod-table'

export const documents = zodTable(
	'documents',
	(id) => ({
		title: z.string(),
		ownerId: id('users'), // `id` is convex-helpers' zid — typed Id<'users'>
		secretNote: z.string(),
		reviewState: z.enum(['draft', 'published']),
	}),
	{
		serverFields: ['reviewState'], // excluded from inserts — server assigns it
		commandFields: ['title'], // the ONLY fields a command may carry
		publicFields: ['title', 'ownerId'], // the DTO allowlist — everything else is redacted
	},
)
```

## What you get back

### Shared ID validation (0.1.3)

Install one compatible `convex-helpers` peer (`>=0.1.127 <0.2.0`) alongside
cvx-kit. ID metadata lives in a helper-instance registry: copying schemas
between separately installed helper instances can silently turn an ID into
`v.any()`. An exact nested dependency previously caused that failure even
when both helper versions were compatible. Fresh npm and Bun consumer tests
now exercise storage, command, DTO, and nested ID conversion with a different
compatible host version.

Prefer the matching kit exports when deriving validators from kit schemas:

```ts
import { zid, zodToConvex, convexToZod } from 'cvx-kit/zod-table'
```

Do not force conflicting nested helper copies with overrides or reuse schema
objects across separate bundles. The upstream converter cannot recognize an
unregistered foreign ID and does not throw; peer installation prevents the
supported package graph from creating that ambiguity. Verify critical ID
validators retain `kind === 'id'` and the expected `tableName` after installation.

| Property                                     | What it is                                             | Where you use it               |
| -------------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| `table`                                      | `defineTable(...)` from the storage shape              | `convex/schema.ts`             |
| `storage`                                    | zod object of the raw row (no `_id`/`_creationTime`)   | validating rows                |
| `schema`                                     | `storage` + `_id` + `_creationTime`                    | full-document validation       |
| `insertSchema`                               | storage minus timestamps minus `serverFields`          | mutation args                  |
| `updateSchema`                               | `insertSchema.partial()`                               | patch mutation args            |
| `commandInput`                               | strict pick of `commandFields`                         | command protocol inputs        |
| `publicDto`                                  | strict pick of `publicFields`                          | query return validators        |
| `dto(options?)`                              | public return schema with optional ID and extensions   | query return validators        |
| `toPublicDto(row)`                           | projects **and re-parses** a row into the DTO          | query handlers                 |
| `paginationOpts(selection)`                  | native pagination options, selected filters, and order | query input validators         |
| `insert(omit?)` / `update(omit?)`            | schema with per-callsite field omission                | specialized mutations          |
| `tools.insert` / `tools.update` / `tools.id` | ready-made LLM tool input schemas                      | agent tool definitions         |
| `tableName`                                  | the literal table name                                 | indexes, triggers registration |

## Redaction is runtime, not just types

`toPublicDto` does not merely `pick` at the type level — it re-parses the
projected object through the strict `publicDto` schema. A field that leaks into
the projection throws instead of shipping to the client. Use it on **every**
row a public query returns:

```ts
export const get = authQuery({
	args: { id: zid('documents') },
	returns: documents.publicDto,
	handler: async (ctx, { id }) => {
		const row = await ctx.db.get(id)
		if (!row) throw new KitError({ code: 'NOT_FOUND' })
		return documents.toPublicDto(row) // secretNote can never leak
	},
})
```

## Public DTO parameters

`publicDto` is the strict Zod schema selected by `publicFields`; it takes no
parameters. Use `dto(...)` to derive a return schema and `toPublicDto(row, ...)`
to project a row with the same options. These methods are also available on
`tenantTable` boundaries.

```ts
documents.toPublicDto(row) // publicFields only
documents.toPublicDto(row, false) // same default projection
documents.toPublicDto(row, true) // publicFields plus _id
documents.toPublicDto(row, { _id: true }) // explicit equivalent

const withoutId = documents.dto() // same boundary as publicDto
const withId = documents.dto(true) // branded Id<'documents'>
const explicit = documents.dto({ _id: true })
```

Including `_id` requires a row containing an ID and validates it through the
table's ID schema. It does not expose `_creationTime`, tenant metadata, or other
storage fields. Do not spread an ID onto a parsed DTO manually; use the matching
`dto(true)` return validator.

Computed fields need both a schema and explicitly supplied values:

```ts
const extend = { url: z.url() }
const returnSchema = documents.dto({ _id: true, extend })

const output = documents.toPublicDto(row, {
	_id: true,
	extend,
	values: { url: `https://example.test/documents/${row._id}` },
})
returnSchema.parse(output)
```

`extend` is a map of field names to Zod validators, not an `extendFields` wrapper.
`values` belongs only to the projector; `dto(...)` describes the result. Extension
values are parsed as a strict object: missing required fields, unknown values,
and invalid values fail. Values are never copied implicitly from storage.

Extensions cannot replace public fields or use `_id`, `_creationTime`, `tenant`,
`createdAt`, `updatedAt`, `archivedAt`, or `__proto__`. Their schemas must validate
without changing values: transforms, pipes, coercion, preprocess, defaults,
catches, and overwrites are rejected, including inside nested schemas.
Refinements must not mutate their input. Existing public-field schemas retain
their existing parsing behavior.

## Pagination options

Select filterable scalar fields independently of the public DTO mask:

```ts
const input = documents.paginationOpts({ title: true, ownerId: true })
const args = input.parse({
	numItems: 25,
	cursor: null,
	order: 'desc',
	filters: { title: 'Proposal' },
})
```

The helper extends Convex's native pagination options with optional `filters`
and `order: 'asc' | 'desc'`. It returns a Zod object that can be used directly as
query args or extended with endpoint-specific fields. `numItems` must be a
positive integer at most 100; engine configuration may lower that ceiling.
Unknown filter fields fail. Stored scalar fields, including explicitly selected
server-owned fields and IDs, can be filterable even when absent from the DTO.
Arrays, objects, and other unsupported non-scalar fields cannot be selected.
This schema creates no authorization policy by itself.

For relationship filters and paginated public output, use
`relations.tables.documents.paginationOpts(selection)` and `.pageDto(selection)`.
See [querying.md](./querying.md) for declarations, conditional indexes, filters,
authorization, and child-page continuation. Existing native pagination can keep
using `paginated(dto)`; the querying engine is independent of `include`.

## Opinionated timestamps

Every `zodTable` bakes in three optional, **server-owned** fields:

- `createdAt` — set once on insert
- `updatedAt` — moved on every update
- `archivedAt` — soft-delete marker, under application control

They are always excluded from `insertSchema`, `updateSchema`, and
`commandInput` — a client or command can never write them. They are _not_ in
`publicFields` by default; list them explicitly when a DTO needs them
(`publicFields: ['title', 'createdAt']`).

They maintain themselves only if you register the `timestamps` trigger once
per table (see `triggers.md`). Without the trigger they stay `undefined`.

Prefer `createdAt` over `_creationTime` in DTOs so the whole lifecycle
vocabulary is yours; `_creationTime` remains available for index ordering.

## Field masks — who sees what

Think of the options as three independent allowlists over the same shape:

- `serverFields` — _the server assigns these._ Excluded from `insertSchema`
  and `updateSchema`. Example: `reviewState`, denormalized counters.
- `commandFields` — _a command may say these._ The command protocol's input
  is exactly this pick, strict. Everything else must be derived by the handler.
- `publicFields` — _a client may see these._ The DTO is exactly this pick;
  may include timestamp fields.

All derived objects are `.strict()` — unknown keys are rejected, in both
directions.

## `tenantTable` — tenant-owned rows

`tenantTable` is `zodTable` plus a server-owned `tenant` string field —
injected exactly like timestamps: present in storage, excluded from
`insertSchema`/`updateSchema`/`commandInput`, in `publicDto` only by explicit
allowlist. Handlers stamp it from `ctx.tenant`; row-level security matches on
it; the `tenantOwnership` trigger forbids reassigning it. See `tenancy.md`.

```ts
export const <entities> = tenantTable('<entities>', (id) => ({ ... }), {
  commandFields: [...], publicFields: [...],
})
```

## `createModule` — module table maps

Merges per-module table maps into the application schema, throwing when two
modules declare the same table — the combinator for `domain/table.ts`:

```ts
export default defineSchema(createModule(<moduleA>Tables, <moduleB>Tables))
```

## `zodVariantTable` — discriminated unions

For tables whose rows are a discriminated union (events, polymorphic
resources), `zodTable`'s object-shape model doesn't apply. `zodVariantTable`
keeps the same "one owner per table" convention while accepting any zod type
as storage:

```ts
const events = zodVariantTable(
	'events',
	z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('created'), by: zid('users') }),
		z.object({ kind: z.literal('archived'), reason: z.string() }),
	]),
)
// events.table → defineTable, events.insertSchema → the union itself
```

The two-argument form keeps its original behavior: no derived masks or timestamps.
Pass a third argument to opt into per-variant boundaries:

```ts
const payments = zodVariantTable(
	'payments',
	z.discriminatedUnion('type', [
		z.strictObject({
			type: z.literal('draft'),
			clientId: zid('clients'),
			amount: z.int().positive(),
			evidence: z.string().optional(),
		}),
		z.strictObject({
			type: z.literal('creditor'),
			clientId: zid('clients'),
			creditorId: zid('creditors'),
			amount: z.int().positive(),
			evidence: z.string().optional(),
		}),
	]),
	{
		discriminator: 'type',
		timestamps: true,
		variants: {
			draft: {
				serverFields: ['evidence'],
				commandFields: ['clientId', 'amount'],
				publicFields: ['clientId', 'amount'],
			},
			creditor: {
				serverFields: ['evidence'],
				commandFields: ['clientId', 'creditorId', 'amount'],
				publicFields: ['clientId', 'creditorId', 'amount'],
			},
		},
	},
)
```

Each branch must be a strict object with one string literal discriminator.
Every tag needs exactly one configuration. Masks accept only that branch's
fields; the discriminator is always retained and must not appear in a mask.
System fields are reserved. Timestamp names remain reserved unless you explicitly
set `timestamps: false`. Root object/union refinements,
transforms, defaults, coercion, and other value-changing validators are rejected.
Pure field refinements are supported. Nested object catchalls are unsupported;
use a record field instead. Bigint fields may be stored, but cannot be selected
as command fields because tool JSON schemas cannot represent them.
Use `zid` in storage to retain native
Convex table-ID validation; generated tool schemas convert IDs to JSON strings.

The result exposes `table`, `storage`, `schema` (including system fields),
`insertSchema`, `updateSchema`, `commandInput`, `publicDto`, `dto(includeId?)`,
`toPublicDto(row, includeId?)`, and `tools.id/insert/update`. Inserts exclude
server fields and managed timestamps. Commands select only the configured command
fields. Tool inserts use the command boundary; tool updates wrap its partial
boundary in `{ id, data }`. All boundaries remain strict discriminated unions.
`dto(true)` includes the table's branded `_id`; DTO extensions are unavailable
in this mode. `toPublicDto` selects the matching branch's whitelist and re-parses
it, removing server evidence and fields belonging to other branches.

With `timestamps: true`, timestamps are optional storage fields; existing triggers must maintain them.
They are private unless explicitly selected in `publicFields`. The helper does
not assign timestamps or server fields.

With `timestamps: false`, declare explicit `createdAt`, `updatedAt`, or
`archivedAt` fields as needed. Their requiredness and field refinements survive
in storage and document boundaries. They follow ordinary masks: put server-owned
fields in `serverFields` to exclude them from insert/update inputs, leave them
out of `commandFields` to exclude them from command/tool inputs, and select only
the intended public fields. For example:

```ts
const ledger = zodVariantTable(
	'ledger',
	z.discriminatedUnion('type', [
		z.strictObject({
			type: z.literal('adjustment'),
			amountCents: z.int(),
			createdAt: z.int().nonnegative(),
			recordedAt: z.int().nonnegative(),
		}),
	]),
	{
		discriminator: 'type',
		timestamps: false,
		variants: {
			adjustment: {
				serverFields: ['createdAt', 'recordedAt'],
				commandFields: ['amountCents'],
				publicFields: ['amountCents', 'createdAt'],
			},
		},
	},
)
```

The handler supplies both timestamps before parsing the complete storage row.
Native Convex validators enforce their required numeric shape; parse with Zod
to enforce integer, nonnegative, and safe-number refinements. Omitting the
timestamp option preserves the existing behavior: no managed fields are added,
but explicit timestamp names remain reserved. Use `false` to opt into explicit
timestamp declarations.

A patch always requires the discriminator. In one Convex mutation, fetch the
stored row, check the discriminator, merge, validate the complete storage row,
and only then write. For example, after parsing `{ id, data }` with `tools.update`:

```ts
const row = await ctx.db.get('payments', id)
if (!row || row.type !== data.type) throw new Error('Variant mismatch')
const { _id, _creationTime, ...stored } = row
payments.storage.parse({ ...stored, ...data })
await ctx.db.patch('payments', id, data)
```

Do not change variants through a patch. Full validation also rejects deleting a
required field with an explicit `undefined`. Native Convex validators preserve
IDs and branch structure but do not enforce Zod field refinements such as
positive integers; parse with Zod in the handler. Add authorization before the
write as appropriate for the application.

The three-argument boundary works with `defineRelations` and the shared query
engine. Common compatible fields use ordinary references; branch-specific
references and predicates carry an explicit discriminator guard. See
[Variant querying](./variant-querying.md) for registration, authenticated
endpoints, mixed pages, and nested continuation. The legacy two-argument helper
does not generate the document and public boundaries required by the registry.

## `jsonSafeZid` — Ids in LLM tool schemas

JSON-schema generators turn `zid('users')` into an opaque custom type that
confuses LLM tool calling. `jsonSafeZid('users')` presents as a plain
described string in the generated JSON schema while keeping `Id<'users'>` at
the type level:

```ts
const assignInput = z.object({
	documentId: jsonSafeZid('documents'), // LLM sees: string, "Convex document id for table \"documents\""
})
```

## Wiring into `schema.ts`

```ts
// convex/schema.ts
import { defineSchema } from 'convex/server'
import { documents } from './tables/documents'

export default defineSchema({
	documents: documents.table
		.index('by_owner', ['ownerId'])
		.index('by_owner_archived', ['ownerId', 'archivedAt']),
})
```

Indexes are chained on `.table` exactly like a hand-written `defineTable`.

## Rules of thumb

1. One `zodTable` per entity, in its own module, exported by name.
2. Never define an inline `defineTable` or a second zod object for the same
   entity — masks only.
3. Every public query returns `publicDto`-shaped data via `toPublicDto`.
4. Every command input is `commandInput` (or a documented composition of it).
5. Timestamps are trigger-maintained; handlers never write them.
