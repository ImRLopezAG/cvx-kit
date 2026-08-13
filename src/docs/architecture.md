# Architecture — the shape of a cvx-kit application

cvx-kit was extracted from a production Convex application (~12k LOC backend).
This document describes the architecture that application follows and that the
kit is designed to reproduce: strict ownership boundaries, injected policy,
portable components, and conventions that are *executable* (enforced by tests)
rather than aspirational.

## The layers

```
convex/
  convex.config.ts        # component mounting — each app.use(x) exactly once
  schema.ts               # defineSchema(domainTables) — nothing else
  functions.ts            # createAuthFunctions(...) — the ONLY place raw builders appear
  foundation.ts           # const { Command, Query, observability } = new Foundation(...)
  approvals.ts            # const approvals = new Approvals(components.approvals)
  audit.ts                # writeAuditEntry over convex-audit-log + admin readers
  triggers.ts             # the single Triggers registry + helper registrations
  auth.ts / auth.config.ts / http.ts   # identity provider wiring (e.g. WorkOS AuthKit)
  api/                    # PUBLIC surface — thin adapters only
    <documents>.ts          #   authQuery/authMutation wrapping domain executors
  domain/
    table.ts              # merges per-domain table maps into domainTables
    shared/               # genuinely cross-entity helpers only
    <entity>/            # one directory per entity/aggregate
      schema.ts           #   zodTable declaration (shapes only)
      table.ts            #   indexes attached to <zodTable>.table
      constants.ts        #   finite vocabularies (UPPER_SNAKE readonly tuples)
      commands.ts         #   operation registry + executors (new Command(...))
      queries.ts          #   domain read logic
      approval.ts         #   approvals.define(...) workflow definitions
      *_functions.ts      #   internal callbacks (systemMutation/systemAction)
```

### Layer rules

1. **`api/` is the only public surface.** It contains no bare `query(` or
   `mutation(` — only `auth*`/`role*`/`admin*` constructors delegating to
   domain `execute*` functions. Public functions are adapters: parse, pass
   `ctx.actor`, project DTOs.
2. **`domain/<entity>/` owns everything about the entity** — its zod shape,
   indexes, vocabularies, commands, queries, workflows. Cross-domain reuse
   goes through `domain/shared/`, never sibling imports of another domain's
   internals.
3. **Root files are facades over mounted components.** `foundation.ts`,
   `approvals.ts`, `audit.ts` configure infrastructure; business definitions
   stay in the owning domain.
4. **Internal functions use `systemMutation`/`systemAction`** — never raw
   `internalMutation(`/`internalAction(` — so triggers and `include` apply to
   scheduled/callback work too.

## Injection, not import

The kit's central design rule: **library code never imports app singletons**.
Every kit surface takes its policy as a parameter:

- `createAuthFunctions` receives the generated builders, `getAuthUser`,
  `mapRole`, `verifyMembership`, `triggers`, `errors`.
- `Foundation` receives `classifyError`, `writeAudit`, the `enabled` flag.
- `Approvals` receives only its component reference; host data crosses as
  opaque validated strings.

The reverse rule holds for components: a portable component must not import
host domains, generated host APIs, environment configuration, or vendor SDKs
(WorkOS, Drizzle, Redis…). Host values cross its public API only as
**validated, bounded, opaque data** — `scopeRef`, `resourceRef`, function
handles. Component schemas contain only their own records and never mirror a
private child component's tables.

## Boundaries as schemas

Data crossing any boundary is a zod schema derived from one `zodTable`
declaration per entity (see `zod-table.md`):

- storage → `defineTable` via `zodToConvex`
- writes → `insertSchema`/`updateSchema` (server fields and timestamps
  excluded)
- commands → `commandInput` (explicit allowlist)
- clients → `publicDto` + `toPublicDto` (runtime redaction)
- LLM tools → `tools.*` and `jsonSafeZid`

Everything is `.strict()`. There is exactly one source of truth per entity and
no boundary that "just trusts" its input.

## Writes as commands

State changes flow through the audited command protocol (see `commands.md`):
parse input → observe → run handler → parse output → write audit — one
transaction, rollback-consistent. Classifications and audit derivation are
type-required per operation. Human-gated changes use the approvals component;
its apply steps are commands too.

## Conventions worth enforcing with tests

The origin app enforces its architecture with a test suite that raw-globs the
source and asserts violations — each rule proved against a synthetic fixture
first so the checker can't silently pass. Highly recommended for consumers:

- **No inline tables/schemas** — `defineTable`/`defineSchema` only in
  `table.ts`/`schema.ts`.
- **No inline enums** — `z.enum([...])` with an inline array literal is
  banned; vocabularies are named `UPPER_SNAKE` tuples in `constants.ts`.
- **No deep server imports** — components consumed only through their
  `client.ts` facade; explicit allowlist for exceptions.
- **No handwritten references** — `makeFunctionReference` banned; use
  generated `internal`/`api`.
- **No sibling-domain imports** — a domain reaches another only via
  `domain/shared/` or the public API.
- **Facades mount once** — every `app.use(x)` appears exactly once; facades
  never reach a component's private children.
- **Component boundary tests** — no host imports, no
  `process.env`/vendor-SDK references inside `components/*`.
- **Copyability** — copy the component to a tmpdir with only its package
  deps, run `tsc`: proves portability continuously.

## Component mounting order

In `convex.config.ts`, mount infrastructure before consumers: auth kit →
foundation → audit log → approvals → named workflow/workpool instances. Use
`app.use(x, { name })` when mounting the same component twice; `components.
<name>` keys off that name. Required env vars can be declared on
`defineApp({ env: { ... } })` so deploys fail fast — remember to stub them in
test setup.
