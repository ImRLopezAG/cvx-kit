# `cvx-kit/triggers` — one application-wide mutation interceptor registry

A single `Triggers` registry (from convex-helpers) is created once per app and
handed to `createAuthFunctions`. From then on, every `authMutation`,
`roleMutation`, and `systemMutation` runs its writes through
`triggers.wrapDB(ctx)` — trigger enforcement is **structural, not a
convention**. A handler cannot skip a trigger because it never sees an
unwrapped `ctx.db`.

## Setup

```ts
// convex/triggers.ts — the single registry
import { appendOnly, createTriggers, noDelete, timestamps } from 'cvx-kit/triggers'
import type { DataModel } from './_generated/dataModel'

export const triggers = createTriggers<DataModel>()

// Server-owned lifecycle timestamps (see zod-table.md)
timestamps(triggers, 'documents', 'projects', 'members')

// Evidence tables: inserts only — updates/deletes throw and roll back
appendOnly(triggers, 'votes', 'history')

// Soft-delete discipline: hard deletes throw
noDelete(triggers, 'documents')

// Domain triggers register on the same instance
triggers.register('documents', async (ctx, change) => {
  if (change.operation === 'insert') { /* denormalize, validate, cascade */ }
})
```

```ts
// convex/functions.ts
createAuthFunctions<DataModel>({ ..., triggers })
```

## The built-in helpers

- **`timestamps(triggers, ...tables)`** — maintains zod-table's opinionated
  fields: sets `createdAt` + `updatedAt` on insert, moves `updatedAt` on every
  update. `archivedAt` stays under application control. Contains its own
  recursion guard (a write that already moved `updatedAt` — including the
  trigger's own patch — is left alone). Register once per table.
- **`appendOnly(triggers, ...tables)`** — inserts pass; any update or delete
  throws, which **rolls back the whole transaction**. The pattern for
  votes/history/audit-style evidence tables.
- **`noDelete(triggers, ...tables)`** — forbids hard deletes only; updates
  pass. Pair with `archivedAt` for soft deletion.

`Triggers`, `Change`, and `Trigger` are re-exported for custom registrations.

## Footguns

1. **Anything outside the kit constructors bypasses every trigger.** Raw
   `mutation`/`internalMutation` from `_generated/server`, and `ctx.db` inside
   `convex-test`'s `t.run(...)`, are unwrapped. Never build a mutation outside
   your `functions.ts`, and expect test-side `t.run` writes to be trigger-free
   (useful for seeding, dangerous for assertions about trigger behavior).
2. **Wrapper spread order matters** if you compose ctx manually:
   `{ ...wrapDB(ctx), ...otherStuff }` — `wrapDB` returns a full ctx, so
   spreading it *after* anything that carries `db` restores the raw database.
   The kit's constructors already order this correctly
   (`{ ...wrapDB(ctx), include, ...authBundle }`).
3. **A throwing trigger aborts the transaction.** That is the point for
   `appendOnly`/`noDelete`, but remember it when writing custom triggers —
   validation triggers should throw; best-effort denormalization should not.
4. **Triggers run per write, in registration order.** Keep them small; heavy
   work belongs in a scheduled function, not in a trigger.
