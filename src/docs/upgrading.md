# Upgrading to 0.1.0 — the new way of things

The migration file for consumers on 0.0.x. Each section: the old way you were
hand-writing, the 0.1.0 way, and what stays unchanged. Nothing existing
breaks in this release except one boundary-mask improvement (see the last
section).

**Semver contract from 0.1.0:** breaking changes land only on minor bumps;
patches are additive or fixes. One caveat, stated honestly: the breaking
window formally closes at the follow-up consolidation release (package-name
decision + full export-name API audit) — until then the six new helper
surfaces may still be renamed in a minor. Every tag now gets a GitHub
Release with CHANGELOG notes.

## Pagination — was: `.take()` loops or hand-bridged validators

Old way:

```ts
// hand-rolled: convexToZod(paginationOptsValidator) in every project,
// or worse, .execute(100) and client-side slicing.
```

New way:

```ts
import { paginated } from 'cvx-kit/zod-table'

const page = paginated(<entities>.publicDto)
export const list = authQuery({
  args: { paginationOpts: page.args.paginationOpts },
  returns: page.result,
  handler: (ctx, args) =>
    ctx.include(ctx.db.query('<entities>'))
      .matching('by_tenant', (ix) => ix.eq('tenant', ctx.tenant))
      .paginate(args.paginationOpts, (rows) => rows.map(<entities>.toPublicDto)),
})
```

Unchanged: `execute(limit)` for non-cursor reads; the maxRows bound applies
to `numItems` too. Under RLS, pages may be SHORTER than `numItems` when
rules reject rows mid-page — cursors remain correct, keep paging until
`isDone`.

## CRUD — was: hand-written create/update/archive per entity

New way:

```ts
import { createCrudCommands } from 'cvx-kit/crud'

const crud = createCrudCommands({
  Command,                             // destructured from your Foundation
  table: <entities>,
  aggregateType: '<entity>',
  actor: (ctx) => ctx.actor.userId,
  enrich: (ctx) => ({ tenant: ctx.tenant }),  // REQUIRED for tenantTables
})
// crud.executeCreate / executeUpdate / executeArchive — audited commands
```

Unchanged: your api/ adapters stay thin; bespoke operations keep using
`Command.operation` directly. Archive is soft-delete only, by doctrine.

## Transition guards — was: hand-written `if` chains

New way:

```ts
import { createStateMachine } from 'cvx-kit/state-machine'

const machine = createStateMachine(<ENTITY>_STATES, {
  draft: ['published', 'archived'],
  published: ['archived'],
})
// in a command guard:
guard: async (ctx, command) => machine.assert(row.state, command.to)
```

## Rate limiting — was: hand-rolled counters or none

New way (host mounts `@convex-dev/rate-limiter`; the kit stays
dependency-free — it receives the instance):

```ts
import { rateLimit } from 'cvx-kit/middleware'

const commands = new Command(operations, {
  middleware: [rateLimit({ limiter, name: '<entities>.write' })],
})
```

Keyed by `ctx.tenant` by default. No tenant and no `key` fn →
`RATE_LIMIT_KEY_MISSING` (configuration error, never a shared bucket).

## Webhooks — was: ad-hoc verification and dedup in the action

New way:

```ts
import { createWebhookBoundary, recordWebhookEvent, webhookEventsTable } from 'cvx-kit/webhooks'

// schema: webhookEvents: webhookEventsTable().table.index('by_eventKey', ['eventKey'])
const boundary = createWebhookBoundary({
  verify: async (raw, request) => timingSafeHmacVerify(raw, request), // RAW body, constant-time, secret from env
  eventKey: (raw) => { const e = JSON.parse(raw); return `${e.event}:${e.id}:${e.updatedAt}` },
})
// http.ts routes to boundary.handle(ctx, request, internal.<module>.functions.applyEvent)
// applyEvent (systemMutation) calls recordWebhookEvent FIRST — transactional dedup.
```

Dedup rows are host-owned: prune on a retention window longer than the
provider's redelivery horizon (cleanup cron over `receivedAt`).

## Agent tools — was: hand-written tool definitions with raw db access

New way:

```ts
import { createAgentTools } from 'cvx-kit/agent-tools'

const tools = createAgentTools(<entities>, {
  create: (ctx, input) => crud.executeCreate(ctx, input),   // audited command
  get: (ctx, { id }) => loadDto(ctx, id),                   // reads: query handlers
  list: (ctx, { paginationOpts }) => listPage(ctx, paginationOpts),
})
// host: spread each record into @convex-dev/agent's createTool (or ai-sdk tool())
```

Shape-compatible, dependency-free; checked against `@convex-dev/agent@0.6.x`
— re-verify at install.

## Typed middleware context — was: loose `next({ context })`

New way:

```ts
const withVendor = Command.middleware<Ctx, { vendor: Vendor }>(
  async ({ context, next }) => next({ context: { vendor: await load(context) } }),
)
// registries/operations accept typed middleware without casts
```

Unchanged: untyped middleware keeps compiling.

## The one behavior change: tool masks use jsonSafeZid

`<table>.tools.update` and `<table>.tools.id` now type ids with
`jsonSafeZid` instead of `zid`, so generated JSON schemas present ids as
plain strings (compile-time `Id<...>` preserved). If you relied on the masks
producing `zid` runtime metadata, re-check; for LLM tool schemas this is the
fix you wanted.
