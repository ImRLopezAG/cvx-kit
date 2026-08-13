# Maintaining a Convex application built on cvx-kit

Practices that keep a cvx-kit backend maintainable over years, taken from the
origin application. The theme throughout: make every rule either *structural*
(the code can't be written any other way) or *executable* (a test fails when
it's violated). Conventions that live only in documentation decay.

## Schema and indexes

- `convex/schema.ts` stays at ~4 lines: `defineSchema(domainTables)`.
  Per-domain `table.ts` files attach indexes to `<zodTable>.table` and
  `domain/table.ts` merges the maps. Shapes (zod) and topology (indexes) are
  deliberately separate files.
- **Index naming**: `by_<field>_and_<field>...`, camelCase field names in
  declaration order, nested paths flattened with `_`
  (`by_assignedToUserId_and_state_status` for `['assignedToUserId',
  'state.status']`). A reader should reconstruct the index definition from its
  name.
- Every read goes through `ctx.include(...)` with an explicit limit ≤ 100.
  If a query can't be served by an index, that's a schema problem, not a
  reason to `fullTableScan`.

## Schema evolution without downtime

Convex validates the whole table against the schema on push, so evolution is
additive:

1. **New fields arrive `.optional()`** with a comment explaining the epoch:
   `// Optional only for documents created before priority was frozen.`
2. Deploy code that writes the new field on every new write and tolerates its
   absence on reads.
3. Backfill if needed (a `systemMutation` batch or `@convex-dev/migrations`),
   then — and only then — consider tightening the schema.
4. Never rename in place: add the new field, dual-write, backfill, drop the
   old one release(s) later.

zod-table makes step 1 cheap: change the shape once and every boundary mask
updates together, with `tsc` pointing at every consumer that must adapt.

## Function hygiene

- Raw `query`/`mutation`/`action` builders appear **only** in `functions.ts`.
  Everything public is `auth*`/`role*`/`admin*`; everything
  internal/scheduled is `system*`. This is what makes triggers, auth, and
  bounded reads impossible to forget.
- Public functions in `api/` are thin: parse args (zod-table masks), call the
  domain executor with `ctx.actor`, project through `toPublicDto`. Business
  logic that lives in an adapter can't be reused by workflows or callbacks —
  keep it in the domain.
- Vocabularies (states, kinds, decisions) are single-owner readonly tuples in
  `constants.ts`. Grep for the tuple name to find every consumer.

## Audit and observability as maintenance tools

- Every state change is a command with a mandatory classification and audit
  derivation — so "what happened to this record" is a query over the audit
  log, not archaeology. Keep operation names stable (`domain.verb`); they are
  your telemetry and audit vocabulary.
- Observability is payload-free by construction — you can leave it on in
  production and grep durable one-line JSON events
  (`event: 'command.execution'`) without PII review.
- Set retention deliberately: audit entries carry the classification as their
  retention category; the approvals component ships `cleanupAudit` for its own
  trail.

## Testing strategy

Three test layers, all in-memory via `convex-test` on `edge-runtime`:

1. **Behavioral tests** — drive functions through the real constructors
   (`t.withIdentity(...)`), assert DTO shapes and trigger effects. Remember:
   `t.run(ctx => ctx.db...)` bypasses triggers — use it for seeding, not for
   asserting write behavior.
2. **Architecture tests** — glob the source and assert the conventions
   (no inline tables/enums, no deep imports, no sibling-domain imports, one
   `app.use` per component, no raw builders outside `functions.ts`). Prove
   each rule against a synthetic violating fixture first.
3. **Boundary/copyability tests** — components contain no host imports and no
   vendor/env references; optionally `cp -r` the component to a tmpdir and
   run `tsc` to prove copy-portability.

Consumers register the kit's components on their test instance:

```ts
import { convexTest } from 'convex-test'
import { registerApprovals, registerFoundation } from 'cvx-kit/test'

const t = convexTest(schema, modules)
registerFoundation(t)
registerApprovals(t)
```

(`cvx-kit/test` ships as source and needs a vitest-compatible runner —
`import.meta.glob`.) Nested components used by approvals register their own
test modules the same way (`@convex-dev/workflow/test`,
`convex-audit-log/test`). Stub required env vars (declared on
`defineApp({ env })`) in test setup.

## Operational habits

- **Env flags over redeploys**: observability is toggled by an env var read
  at call time (`enabled: () => env.OBS === 'true'`).
- **Fail closed**: membership verification errors reject; unknown roles
  reject; unreadable transaction metrics rethrow. Preserve this bias in app
  code.
- **Soft deletes** (`archivedAt` + `noDelete`) for anything a human might ask
  about later; `appendOnly` for evidence tables. Hard deletes are a data-loss
  bug you opt into per table.
- **Component upgrades**: components own their tables; upgrade them like
  services — read the component's migration notes, bump, run codegen, run the
  suite. Never write to a component's tables from the host.

## Checklist for a new entity

1. `domain/<entity>/schema.ts` — `zodTable` with the three masks thought
   through (`serverFields`, `commandFields`, `publicFields`).
2. `domain/<entity>/table.ts` — indexes, named `by_...`.
3. Register in `domain/table.ts`; add `timestamps(triggers, '<table>')` and
   any `appendOnly`/`noDelete` discipline.
4. `constants.ts` — vocabularies as readonly tuples.
5. `commands.ts` — operation registry (`domain.verb`, classification, audit)
   + executors.
6. `api/<entity>.ts` — thin `auth*` adapters, DTO projection.
7. Tests: behavior + add the entity to the architecture globs.
