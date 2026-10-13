# Variant tables in the shared query engine

The three-argument `zodVariantTable` boundary supports one physical table with
branch-specific storage, commands, DTOs, and relations. Mixed pages preserve
literal tags and branded IDs. Configure the same global engine and authenticated
query facade used for ordinary tables; see [querying](./querying.md) and
[auth](./auth.md).

## Declare boundaries and indexes

```ts
// convex/domain/payments/schema.ts
import { z } from 'zod'
import { zid, zodTable, zodVariantTable } from 'cvx-kit/zod-table'

export const clients = zodTable('clients', () => ({ name: z.string() }), {
  publicFields: ['name'],
})
export const creditors = zodTable('creditors', () => ({ name: z.string() }), {
  publicFields: ['name'],
})
export const payments = zodVariantTable('payments', z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('client_draft'),
    clientId: zid('clients'),
    amountCents: z.int().positive(),
    draftDate: z.int().nonnegative(),
    external: z.strictObject({ providerId: z.string() }).optional(),
  }),
  z.strictObject({
    type: z.literal('creditor_payment'),
    clientId: zid('clients'),
    creditorId: zid('creditors'),
    amountCents: z.int().positive(),
    external: z.strictObject({ providerId: z.string() }).optional(),
  }),
]), {
  discriminator: 'type',
  timestamps: true,
  variants: {
    client_draft: {
      serverFields: ['external'],
      commandFields: ['clientId', 'amountCents', 'draftDate'],
      publicFields: ['clientId', 'amountCents', 'draftDate'],
    },
    creditor_payment: {
      serverFields: ['external'],
      commandFields: ['clientId', 'creditorId', 'amountCents'],
      publicFields: ['clientId', 'creditorId', 'amountCents'],
    },
  },
})
```

```ts
// convex/domain/payments/table.ts
import { clients, creditors, payments } from './schema'

const paymentTable = payments.table
  .index('by_clientId', ['clientId'])
  .index('by_type_clientId', ['type', 'clientId'])
  .index('by_creditorId', ['creditorId'])

export const tables = {
  clients: clients.table,
  creditors: creditors.table,
  payments: paymentTable,
}
```

```ts
// convex/schema.ts
import { defineSchema } from 'convex/server'
import { tables } from './domain/payments/table'
export default defineSchema(tables)
```

Declare indexes before compiling relations. Registration verifies the exact native
table owners, every branch's storage validators, public masks, and supporting
indexes. The legacy two-argument helper does not generate the required registry
boundaries. Do not flatten a variant into an object of optional properties.

## Declare common and branch relations

```ts
// convex/relations.ts
import { defineRelations } from 'cvx-kit/relations'
import { tables } from './domain/payments/table'
import { clients, creditors, payments } from './domain/payments/schema'

export const relations = defineRelations({
  clients,
  creditors,
  payments: { ...payments, table: tables.payments },
}, (r, branch) => ({
  clients: {
    payments: r.many.payments({ from: r.clients._id, to: r.payments.clientId }),
  },
  payments: {
    client: r.one.clients({ from: r.payments.clientId, to: r.clients._id }),
    creditor: r.one.creditors({
      from: branch('payments', 'creditor_payment').creditorId,
      to: r.creditors._id,
    }),
  },
  creditors: {
    payments: r.many.payments({
      from: r.creditors._id,
      to: branch('payments', 'creditor_payment').creditorId,
    }),
  },
}))
```

Common references require the field to be declared in every branch with a
compatible native domain, including the same ID target. Optional or nullable
references retain absence semantics. A same-name string/ID or differently
targeted ID is branch-specific. The discriminator is a common literal-union field.

`branch(table, tag)` exposes that branch's fields and carries its tag through
direct joins, junction legs, predicates, and continuation. It can also scope a
common field such as `_id`. A draft's selected `creditor` is `null`, and the engine
does no creditor lookup even if the raw draft has a stray `creditorId`. An absent
optional reference returns `null` or an empty completed many page. Source and
target policies still apply; missing and unreadable targets have the same result.

## Wire contracts and an authenticated endpoint

```ts
// convex/querying.ts
import { createQueryEngine } from 'cvx-kit/querying'
import schema from './schema'
import { relations } from './relations'
export const querying = createQueryEngine({ schema, relations })
```

```ts
// convex/domain/payments/contracts.ts
import { relations } from '../../relations'

export const listInput = relations.tables.payments.paginationOpts({
  type: true,
  clientId: true,
  amountCents: true,
  variants: {
    client_draft: { draftDate: true },
    creditor_payment: { creditorId: true },
  },
})
export const listResult = relations.tables.payments.pageDto({ client: true, creditor: true })
```

```ts
// convex/api/payments.ts
import { authQuery } from '../functions'
import { querying } from '../querying'
import { listInput, listResult } from '../domain/payments/contracts'

export const list = authQuery({
  args: listInput,
  returns: listResult,
  handler: (ctx, args) => querying(ctx)
    .payments.with({ client: true, creditor: true }).paginate(args),
})
```

`functions.ts` must supply the application's configured `createAuthFunctions`
facade, effective read policies, and membership resolution. These declarations
do not grant access. Configure the server cursor key ring described in
[querying](./querying.md). Unmanaged query contexts fail closed.

The result exposes only the matching branch's public mask and `_id`. It excludes
`external`, private timestamps, `_creationTime`, and fields of another branch.
Narrow rows by `row.type` to access `draftDate` or `creditorId`. Selected relations
remain composed into the inferred branch DTO; no handwritten union is needed.

## Filter and continue

```ts
listInput.parse({
  numItems: 20,
  cursor: null,
  filters: {
    variant: {
      tag: 'creditor_payment',
      filters: { creditorId: selectedCreditorId, amountCents: { gte: 100 } },
    },
  },
})
```

`variants` declares allowed client branch filters. `variant` selects a tag and
ANDs it with its child predicate. Branch-only fields outside that node are
rejected, including beside an ordinary `type` equality. Server `.where(...)`
uses the complete grammar and ANDs its constraints with client filters.

Each `or` arm retains its own guard. `not: { variant: A }` includes other
branches and A rows failing the child predicate; `variant: { tag: A, filters:
{ not: P } }` includes only A rows failing P. Contradictory tag constraints match
no rows. Optional-field `exists` is evaluated within the guarded branch.
Relation predicates use authorized targets: an inapplicable one matches `null`,
while an inapplicable many matches `none` and does not match `some`.

Mixed queries retain a single native ordered stream. Branch-only index prefixes
require a guaranteed matching tag; incompatible explicit indexes fail. A relation
retains its mandatory parent equality, including with a tag-prefixed index.
Client predicates cannot replace that constraint.

Use the same `order`, filters, and `.with(...)` selection with each root
`continueCursor`. For a nested clients-to-payments page, continue through
`querying(ctx).clients.relation(clientId, 'payments').with({ client: true,
creditor: true }).paginate(options)`. Bind `clientId` with the clients table's
generated ID validator in the child endpoint. Preserve the nested page's original
selection and filters when resuming; changing page size alone is allowed.

Cursors bind branch filters, registry branch/DTO/guard metadata, index, order,
selection, parent path, and managed security scope. Resume reauthorizes parents,
junctions, and targets. Authorization and branch eligibility happen before page
filling. Duplicate junction occurrences remain visible. Invalid branch data
fails through the engine's redacted execution error boundary.

For atomic tagged patches, use the fetch, authorize, tag-check, merge, and full
storage-validation sequence in [zod-table](./zod-table.md). A query's branch filter
does not authorize a write or convert an existing row to another branch.

## Verify

`bun run test:package:variant-querying` installs a packed consumer, generates real
Convex types, and exercises native commands and shared-engine pages. The runner
also accepts `--package cvx-kit@<version>` to repeat the flow against npm.
CI runs the bounded integration suites; `bun run test` retains the full local
suite, including relational stress tests. Native local evidence does not measure
hosted production performance.
