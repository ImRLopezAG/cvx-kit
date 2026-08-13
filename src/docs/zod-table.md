# `cvx-kit/zod-table` — one zod shape per entity, masked into every boundary

The core idea: an entity's shape is declared **once** as a zod object, and every
boundary that shape crosses — storage, insert, update, command input, public
DTO, LLM tool input — is a *derived mask* of that single declaration. There is
no second source of truth to drift.

```ts
import { z } from 'zod'
import { zodTable } from 'cvx-kit/zod-table'

export const documents = zodTable(
  'documents',
  (id) => ({
    title: z.string(),
    ownerId: id('users'),        // `id` is convex-helpers' zid — typed Id<'users'>
    secretNote: z.string(),
    reviewState: z.enum(['draft', 'published']),
  }),
  {
    serverFields: ['reviewState'],       // excluded from inserts — server assigns it
    commandFields: ['title'],            // the ONLY fields a command may carry
    publicFields: ['title', 'ownerId'],  // the DTO allowlist — everything else is redacted
  },
)
```

## What you get back

| Property | What it is | Where you use it |
|---|---|---|
| `table` | `defineTable(...)` from the storage shape | `convex/schema.ts` |
| `storage` | zod object of the raw row (no `_id`/`_creationTime`) | validating rows |
| `schema` | `storage` + `_id` + `_creationTime` | full-document validation |
| `insertSchema` | storage minus timestamps minus `serverFields` | mutation args |
| `updateSchema` | `insertSchema.partial()` | patch mutation args |
| `commandInput` | strict pick of `commandFields` | command protocol inputs |
| `publicDto` | strict pick of `publicFields` | query return validators |
| `toPublicDto(row)` | projects **and re-parses** a row into the DTO | query handlers |
| `insert(omit?)` / `update(omit?)` | schema with per-callsite field omission | specialized mutations |
| `tools.insert` / `tools.update` / `tools.id` | ready-made LLM tool input schemas | agent tool definitions |
| `tableName` | the literal table name | indexes, triggers registration |

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

## Opinionated timestamps

Every `zodTable` bakes in three optional, **server-owned** fields:

- `createdAt` — set once on insert
- `updatedAt` — moved on every update
- `archivedAt` — soft-delete marker, under application control

They are always excluded from `insertSchema`, `updateSchema`, and
`commandInput` — a client or command can never write them. They are *not* in
`publicFields` by default; list them explicitly when a DTO needs them
(`publicFields: ['title', 'createdAt']`).

They maintain themselves only if you register the `timestamps` trigger once
per table (see `triggers.md`). Without the trigger they stay `undefined`.

Prefer `createdAt` over `_creationTime` in DTOs so the whole lifecycle
vocabulary is yours; `_creationTime` remains available for index ordering.

## Field masks — who sees what

Think of the options as three independent allowlists over the same shape:

- `serverFields` — *the server assigns these.* Excluded from `insertSchema`
  and `updateSchema`. Example: `reviewState`, denormalized counters.
- `commandFields` — *a command may say these.* The command protocol's input
  is exactly this pick, strict. Everything else must be derived by the handler.
- `publicFields` — *a client may see these.* The DTO is exactly this pick;
  may include timestamp fields.

All derived objects are `.strict()` — unknown keys are rejected, in both
directions.

## `zodVariantTable` — discriminated unions

For tables whose rows are a discriminated union (events, polymorphic
resources), `zodTable`'s object-shape model doesn't apply. `zodVariantTable`
keeps the same "one owner per table" convention while accepting any zod type
as storage:

```ts
const events = zodVariantTable('events', z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('created'), by: zid('users') }),
  z.object({ kind: z.literal('archived'), reason: z.string() }),
]))
// events.table → defineTable, events.insertSchema → the union itself
```

Note: variant tables do not get the timestamp fields or boundary masks — the
union is the boundary.

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
