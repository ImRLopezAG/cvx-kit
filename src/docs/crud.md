# `cvx-kit/crud` — the CRUD command factory

`createCrudCommands` generates the three standard operations every entity
starts with — create, update, archive — from one zodTable declaration,
**fully inside the audited command pipeline**: strict command inputs from
`commandFields`, mandatory audit with a declared aggregate type (enforced by
the aggregates allowlist), observability, guards, and middleware.

> convex-helpers ships a same-named `crud` helper. It was deliberately not
> used here: it bypasses the command pipeline — no audits, no guards, and
> hard deletes. This factory is the kit-doctrine equivalent.

## Usage

```ts
import { createCrudCommands } from 'cvx-kit/crud'
import { Command } from '../foundation'          // the destructured facade

const crud = createCrudCommands({
  Command,
  table: <entities>,                              // a zodTable / tenantTable
  aggregateType: '<entity>',
  classification: 'business',                     // default
  actor: (ctx) => ctx.actor.userId,               // audited actor
  enrich: (ctx) => ({ tenant: ctx.tenant }),      // server-owned stamps on create
  guards: { archive: (ctx, command) => machine.assert(...) },  // optional
  middleware: [rateLimit({ limiter, name: '<entities>.write' })], // optional
})

// thin api adapters:
export const create = authMutation({
  args: <entities>.commandInput,
  handler: (ctx, args) => crud.executeCreate(ctx, args),
})
```

## What gets generated

| Operation | Input | Effect | Audit aggregate id |
|---|---|---|---|
| `<table>.create` | `commandInput` (strict) + `enrich` stamps | insert | the new row id |
| `<table>.update` | `{ id, data: commandInput.partial() }` (strict) | patch | the row id |
| `<table>.archive` | `{ id }` | sets `archivedAt` (soft delete ONLY) | the row id |

No hard-delete operation is generated — kit doctrine (`noDelete` +
`archivedAt`).

## Tenancy

- `enrich` is **required for tenantTables** — the factory fails fast with
  `CRUD_ENRICH_REQUIRED` instead of letting untenanted rows ship. Stamp
  `tenant: ctx.tenant` there.
- Generated update/archive take client-supplied ids: with `security.tenancy`
  configured, the RLS-wrapped writer rejects cross-tenant writes (this is
  covered by the kit's own tests) — but keep `requireTenantReference` in
  bespoke guards that load rows.

## Wiring agents

The executors are the natural handlers for `createAgentTools` mutation
kinds — agents get audited commands, never raw db access. See
`agent-tools.md`.
