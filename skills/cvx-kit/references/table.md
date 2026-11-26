# `cvx-kit/table` — one field object per entity, masked into every boundary

For component-local schemas, builders and triggers, see [components](components.md). The field schemas are `k` schemas; see [k](k.md).

An entity's fields are declared once, as a plain object of `k` fields. Every boundary those fields cross (storage, insert, update, command input, public DTO, agent tool input) is a derived mask of that one declaration, so there is no second source of truth to drift.

```ts
import { k } from 'cvx-kit/k'
import { kTable } from 'cvx-kit/table'

const REVIEW_STATES = ['draft', 'published'] as const

export const documents = kTable(
	'documents',
	{
		title: k.string().trim().min(1),
		ownerId: k.id('users'),
		secretNote: k.string(),
		reviewState: k.enum(REVIEW_STATES).default('draft'),
	},
	{
		serverFields: ['reviewState'], // excluded from inserts; the server assigns it
		commandFields: ['title'], // the only fields a command may carry
		publicFields: ['title', 'ownerId'], // the DTO allowlist; everything else is redacted
	},
)
```

`kTable`, `createTable`, `tenantTable`, `kVariantTable`, `paginated`, `createModule`, the namespace helpers and `TIMESTAMP_FIELDS` are exported from `cvx-kit/table` and from `cvx-kit`.

## Field rules

- Fields are a plain object, not a callback. Ids are `k.id('table')`.
- Field schemas may use checks, defaults, refinements and the type-preserving normalisers `trim`, `toLowerCase`, `toUpperCase` and `overwrite`.
- A field with `transform` or `pipe` (including the date conversions such as `k.isoDate().toTimestamp()`) is a type error, and defining the table throws an error naming the field. Convert in function args instead.
- `_id`, `_creationTime`, `createdAt`, `updatedAt` and `archivedAt` are reserved and cannot be declared.
- Every name in `serverFields`, `commandFields` and `publicFields` must be a declared field (`publicFields` may also name the timestamps). A server field cannot be a command field.

## Reuse shared fields with `createTable`

```ts
import { k } from 'cvx-kit/k'
import { createTable } from 'cvx-kit/table'

const customTable = createTable({
	ref: k.string(),
	nextActivity: k.string(),
})

export const tasks = customTable(
	'tasks',
	{ title: k.string(), ownerId: k.id('users') },
	{ commandFields: ['ref', 'title'], publicFields: ['ref', 'nextActivity', 'title'] },
)

export const projects = customTable('projects', { name: k.string() })
```

Both tables contain `ref` and `nextActivity` ahead of their own fields, plus the timestamps. Shared fields are ordinary user fields: they take part in storage, inputs, tools, indexes and the masks; list them in `serverFields` when the server owns them. A table cannot redeclare a shared field name, and shared fields cannot use reserved names or transforms.

## What you get back

| Property                                     | What it is                                                         | Where you use it              |
| -------------------------------------------- | ------------------------------------------------------------------ | ----------------------------- |
| `table`                                      | `defineTable(storage.validator)`, built on first read              | `convex/schema.ts`            |
| `storage`                                    | `k` object of the stored row (no `_id`/`_creationTime`)            | validating rows               |
| `schema`                                     | `storage` + `_id` + `_creationTime`                                | full-document validation      |
| `insertSchema`                               | storage minus timestamps minus `serverFields`                      | insert args                   |
| `updateSchema`                               | `insertSchema.partial()`; fills no defaults                        | patch args                    |
| `commandInput`                               | pick of `commandFields`                                            | command inputs                |
| `publicDto`                                  | pick of `publicFields`                                             | return validators             |
| `dto(options?)`                              | public return schema with optional `_id` and extensions            | return validators             |
| `toPublicDto(row, options?)`                 | projects a row and re-checks it against the public shape           | query handlers                |
| `paginationOpts(selection, options?)`        | native pagination options with selected filters and order          | query args                    |
| `insert(...omit)` / `update(...omit)`        | `insertSchema` / `updateSchema` without the named fields           | specialised mutations         |
| `tools.insert` / `tools.update` / `tools.id` | agent tool input schemas: `commandInput`, `{ data, id }`, `{ id }` | agent tool definitions        |
| `tableName`                                  | the literal table name                                             | indexes, trigger registration |

Every schema-valued boundary is a strict `k` object. `insert` and `update` take field names as strings: `documents.insert('secretNote')`, not `insert({ secretNote: true })`.

Each boundary is built when it is first read and then reused. `table`, `storage` and the other schema boundaries are read-only accessors on the boundary object, so an object spread (`{ ...documents }`) does not copy them. To add field groups for the query engine, wrap the boundary with `withFieldGroups(documents, { ... })` from `cvx-kit/relations` (see [querying](querying.md)).

## Defaults

A default on a field is stored as an optional field, exactly as v1 stored it:

- `insertSchema`, `commandInput`, `storage.parse` and `tools.insert` fill the default, and their input types mark the field optional.
- `updateSchema`, `update(...)` and `tools.update.data` do not fill defaults, so a patch that omits the field leaves the stored value alone.
- `toPublicDto` fills the default when a stored row lacks the field, so `publicDto` and `dto()` mark the field required on their output side.

## Redaction is checked at runtime

`toPublicDto` reads only the public fields from the row and re-checks the projection structurally against the public shape. A value outside a field's shape, including an unknown key inside a nested object, throws a `VALIDATION` error instead of reaching the client. Checks and normalisers are not re-run on stored values; they ran when the row was written. Use it on every row a public query returns:

```ts
export const get = authQuery({
	args: { id: k.id('documents') },
	returns: documents.publicDto,
	handler: async (ctx, { id }) => {
		const row = await ctx.db.get(id)
		if (!row) throw new KitError({ code: 'NOT_FOUND' })
		return documents.toPublicDto(row) // secretNote can never leak
	},
})
```

Return the projection, not the row: the kit does not strip return values, so a row with more fields than `returns` declares fails Convex's return validation.

## Public DTO parameters

`publicDto` is the schema selected by `publicFields`; it takes no parameters. Use `dto(...)` for a return schema and `toPublicDto(row, ...)` to project a row with the same options. These methods exist on `kTable`, `createTable` and `tenantTable` boundaries.

```ts
documents.toPublicDto(row) // publicFields only
documents.toPublicDto(row, true) // publicFields plus _id
documents.toPublicDto(row, { _id: true }) // explicit equivalent

const withoutId = documents.dto() // same schema as publicDto
const withId = documents.dto(true) // _id typed Id<'documents'>
```

Including `_id` requires a row that has one and checks it with the table's id schema. It does not expose `_creationTime`, `tenant` or other stored fields. Do not spread an id onto a projection by hand; use `dto(true)` as the return validator.

Computed fields need both a schema and explicitly supplied values:

```ts
const extend = { url: k.string() }
const returns = documents.dto({ _id: true, extend })

const output = documents.toPublicDto(row, {
	_id: true,
	extend,
	values: { url: `https://example.test/documents/${row._id}` },
})
```

`extend` is a map of field names to `k` schemas. `values` belongs only to the projector; `dto(...)` describes the result. Extension values are parsed as a strict object: missing required fields, unknown keys and invalid values fail. Values are never copied from storage. Extensions cannot replace public fields or use `_id`, `_creationTime`, `tenant`, `createdAt`, `updatedAt`, `archivedAt` or `__proto__`, and their schemas must only validate: defaults, normalisers, transforms, pipes and `strip()` are rejected, including inside nested schemas.

## Pagination options

Select filterable fields independently of the public DTO mask:

```ts
const input = documents.paginationOpts({ title: true, ownerId: true })
const args = input.parse({
	numItems: 25,
	cursor: null,
	order: 'desc',
	filters: { title: 'Proposal' },
})
```

The result is a `k` object of Convex's native pagination options plus optional `filters` and `order: 'asc' | 'desc'`. Use it directly as query args or `.extend(...)` it. `numItems` must be a positive integer, at most 100; engine configuration may lower that. Unknown filter fields fail. Stored scalar fields, timestamps, system fields, server fields and ids can be selected even when they are not public; arrays, objects and other non-scalar fields cannot. Pass `{ validator: 'compact' }` to export a smaller native validator; the kit then validates the filter fully itself. The schema creates no authorization policy.

For relationship filters and paginated public output, use `relations.tables.documents.paginationOpts(selection)` and `.pageDto(selection)`; see [querying](querying.md). Plain native pagination can keep using `paginated(dto)`, which returns `{ args: { paginationOpts }, result }`.

## Timestamps

Every table adds three optional, server-owned number fields:

- `createdAt`: set once on insert
- `updatedAt`: moved on every update
- `archivedAt`: soft-delete marker, under application control

They are excluded from `insertSchema`, `updateSchema` and `commandInput`. They are not public unless listed in `publicFields`. They maintain themselves only when the `timestamps` trigger is registered for the table (see [triggers](triggers.md)); without it they stay `undefined`. Prefer `createdAt` over `_creationTime` in DTOs; `_creationTime` stays available for index ordering.

## Field masks

The options are three independent allowlists over the same fields:

- `serverFields`: the server assigns these. Excluded from `insertSchema` and `updateSchema`.
- `commandFields`: a command may carry these. `commandInput` is exactly this pick.
- `publicFields`: a client may see these. `publicDto` is exactly this pick; it may include timestamps.

Every derived object is strict: unknown keys are rejected.

## `tenantTable` — tenant-owned rows

`tenantTable` is `kTable` plus a required, server-owned `tenant` string (`k.string().min(1)`): stored, excluded from `insertSchema`, `updateSchema` and `commandInput`, and public only when listed in `publicFields`. Handlers stamp it from `ctx.tenant`, row-level security matches on it, and the `tenantOwnership` trigger forbids reassigning it. See [tenancy](tenancy.md).

```ts
export const invoices = tenantTable(
	'invoices',
	{ number: k.string(), customerId: k.id('customers') },
	{ commandFields: ['number', 'customerId'], publicFields: ['number', 'customerId'] },
)
```

## `createModule` — module table maps

Merges per-module table maps into the application schema and throws when two modules declare the same table:

```ts
export default defineSchema(createModule(moduleATables, moduleBTables))
```

## `namespace` — qualified names without renaming tables

`namespace(name, tables)` tags a module map with a declaration-level namespace. Keys stay the stored table names, so storage, `k.id('items')`, `ctx.db.query('items')` and generated types are unchanged. Each table's member name is its PascalCase form and its qualified name is `<Namespace>.<Member>`.

```ts
export const Inventory = namespace('Inventory', {
	items: items.table.index('by_no', ['tenant', 'no']),
	itemLedgerEntries, // a boundary is accepted; its tableName must equal the key
})
export const domainTables = createModule(Inventory, Sales, legacyTables) // flat map
export const tableNames = namespaceIndex(Inventory, Sales)
tableNames.qualifiedName('itemLedgerEntries') // 'Inventory.ItemLedgerEntries' (literal type)
tableNames.namespaceOf('items') // 'Inventory'
tablesOf(Inventory) // ['items', 'itemLedgerEntries']
```

Tables stored with the namespace prefix drop it from their member name: `Inventory_Items` in `Inventory` is `Inventory.Items`, and `Microsoft_Inventory_Items` in `Microsoft.Inventory` is `Microsoft.Inventory.Items`. Pass `{ prefixed: true }` to require the prefix on every key; a key without it is a type error and a runtime error:

```ts
export const Inventory = namespace(
	'Inventory',
	{ Inventory_Items: items.table }, // items = tenantTable('Inventory_Items', …)
	{ prefixed: true },
)
```

Dotted names (`'Microsoft.Inventory'`) are allowed; each segment is an identifier starting with a letter, so lowercase names work too: `namespace('sales', { sales_header: … }, { prefixed: true })` gives `qualifiedName('sales_header') === 'sales.header'`. Prefix matching is case-sensitive. `createModule` and `namespaceIndex` throw on a duplicate namespace name or a table claimed twice.

## `kVariantTable` — discriminated unions

For tables whose rows are a discriminated union, the two-argument form stores the schema as declared and exposes `tableName`, `table`, `storage` and `insertSchema` (the schema itself), with no masks or timestamps:

```ts
const events = kVariantTable(
	'events',
	k.discriminatedUnion('kind', [
		k.object({ kind: k.literal('created'), by: k.id('users') }),
		k.object({ kind: k.literal('archived'), reason: k.string() }),
	]),
)
```

Pass a third argument for per-variant boundaries:

```ts
const payments = kVariantTable(
	'payments',
	k.discriminatedUnion('type', [
		k.object({
			type: k.literal('draft'),
			clientId: k.id('clients'),
			amount: k.int().min(1),
			evidence: k.string().optional(),
		}),
		k.object({
			type: k.literal('creditor'),
			clientId: k.id('clients'),
			creditorId: k.id('creditors'),
			amount: k.int().min(1),
			evidence: k.string().optional(),
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

Rules for the three-argument form:

- The schema is a `k.discriminatedUnion` on the configured discriminator. Each branch is a `k.object` whose discriminator is one `k.literal('…')` string.
- Every tag needs exactly one configuration. Masks accept only that branch's fields; the discriminator is always kept and must not appear in a mask.
- Branch fields must only validate: defaults, normalisers, transforms, pipes and `strip()` are rejected. Field refinements and checks are allowed. Refinements on a branch object or on the union are rejected.
- System fields are reserved. Timestamp names stay reserved unless `timestamps: false`.
- `int64` fields may be stored but cannot be command fields, because tool JSON Schema cannot represent a bigint.

The result exposes `table`, `storage`, `schema` (with system fields), `insertSchema`, `updateSchema`, `commandInput`, `publicDto`, `dto(includeId?)`, `toPublicDto(row, includeId?)` and `tools.id/insert/update`. Each is a discriminated union of per-branch objects. Inserts exclude server fields and managed timestamps; commands select only the command fields; `tools.update` wraps the partial command boundary in `{ id, data }`, and `data` keeps the discriminator. `dto(true)` adds the branded `_id`; DTO extensions are not available in this mode. `toPublicDto` projects the matching branch's public fields, removing server evidence and other branches' fields, and throws for an unknown tag.

With `timestamps: true`, the timestamps are optional stored fields, maintained by triggers and private unless listed in `publicFields`. With `timestamps: false`, declare `createdAt`, `updatedAt` or `archivedAt` yourself as needed; they follow the ordinary masks:

```ts
const ledger = kVariantTable(
	'ledger',
	k.discriminatedUnion('type', [
		k.object({
			type: k.literal('adjustment'),
			amountCents: k.int(),
			createdAt: k.timestamp(),
			recordedAt: k.timestamp(),
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

A patch always carries the discriminator. In one mutation, fetch the stored row, check the tag, merge, parse the complete storage row, then write. After parsing `{ id, data }` with `tools.update`:

```ts
const row = await ctx.db.get('payments', id)
if (!row || row.type !== data.type) throw new Error('Variant mismatch')
const { _id, _creationTime, ...stored } = row
payments.storage.parse({ ...stored, ...data })
await ctx.db.patch('payments', id, data)
```

Do not change variants through a patch. Native Convex validation keeps ids and branch structure but does not run field checks such as `k.int().min(1)`; the `parse` call does. Add authorization before the write.

The three-argument boundary works with `defineRelations` and the query engine; see [variant-querying](variant-querying.md). The two-argument form does not produce the document and public boundaries the registry needs.

## Ids in agent tool schemas

`tools.*` keep ids as `k.id(...)`, so Convex validates them natively. `toJsonSchema` from `cvx-kit/json-schema` renders an id as a JSON string, so agent tool schemas need no special id helper. See [agent-tools](agent-tools.md).

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

1. One `kTable` per entity, in its own module, exported by name.
2. Never write an inline `defineTable` or a second object schema for the same entity; use the masks.
3. Every public query returns `publicDto`-shaped data through `toPublicDto`.
4. Every command input is `commandInput` (or a documented composition of it).
5. Timestamps are trigger-maintained; handlers never write them.
