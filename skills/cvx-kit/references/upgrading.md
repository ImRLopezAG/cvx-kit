# Upgrading to 0.1.0 — the new way of things

## Current dependency requirements

Install Convex 1.46 or newer and convex-helpers 0.1.127 or newer (below 0.2.0).
These minimums match workflow 0.4.10. Regenerate your lockfile after updating.
Auth declarations retain native Convex context types across package versions;
the regression fixture also checks Convex 1.45, which is below the current
full-package dependency minimum.

## Current command API — Effect declarations

`Foundation.Command` and its separate `exec({ operation, handler })` API are
deprecated. For new command code, use `createEffectFoundation` from
`cvx-kit/effect`, declare handlers inside `command({...})`, and return
`exec(operation, input, host)` through a shared Effect API builder.
See [commands.md](./commands.md) for migration steps. Existing consumers remain
compatible; older release sections below describe their historical APIs.

## Request scope, failure audit, error helpers and actions

These replace four patterns that large apps hand-rolled on top of the Effect
registries. Each step below can land on its own. The default nested-audit
behavior changed, so read step 1 before upgrading. The full API is in
[effect.md](./effect.md#request-scope-and-nested-audit).

### 1. Nested audit — was: a `nestedAudit` flag in every bound context

Before, every parent registry spread a flag into the contexts it bound, and
every audit callback checked it:

```ts
// was: domain/sales/commands.ts
context: (ctx: AuthCtx<'mutation'>) => ({
  ...ctx,
  customers: customersCommands.withContext({ ...ctx, nestedAudit: true }),
}),

// was: domain/sales/customers/commands.ts
audit: ({ operation, result }, ctx) =>
  ctx.nestedAudit
    ? null
    : { operation: `sales.${operation}`, actorId: ctx.actor.userId, aggregate: { type: 'sales', id: result._id } },
```

Now nested `exec` calls join the caller's request scope. A command nested under
an auditing operation skips its own audit callback and write, so delete the flag,
the `nestedAudit?: boolean` context field and the ternary:

```ts
context: (ctx: AuthCtx<'mutation'>) => ({ ...ctx, customers: customersCommands.withContext(ctx) }),

audit: ({ operation, result }, ctx) => ({
  operation: `sales.${operation}`,
  actorId: ctx.actor.userId,
  aggregate: { type: 'sales', id: result._id },
}),
```

- A command whose ancestors declare no audit (for example one nested in a query)
  still audits. Actions never fold, because their writes commit independently.
- To keep one entry per nested operation, set
  `createEffectFoundation({ nestedAudit: 'separate' })` and correlate with the
  audit callback's third argument, `scope` (`{ root, parent, depth }`).
- Replace `Effect.runPromise(otherCommands.exec(...))` inside handlers with a
  yielded `exec`. A Promise bridge opens a new scope and audits as a root.
- Drop any lint rule that enforced the flag.

### 2. Errors — was: per-domain `attempt` and a throwing `fail`

```ts
// was: domain/sales/errors.ts
export function fail(code): never { throw salesErrors.create(code, {}) }
export function attempt<A>(run: () => Promise<A>) {
  return Effect.tryPromise({ try: run, catch: (error) => error })
}

// was, in a handler
return yield* Effect.fail(salesErrors.create('NOT_FOUND', {}))
```

Delete those helpers. Contracted registries whose `errors` comes from
`defineErrorContract` receive typed `fail` and `attempt` on the factory;
anywhere else, call `effectErrors(salesErrors)`:

```ts
operations: ({ command, fail, attempt }) => ({
  'sales.post': command.handler((input, ctx) =>
    Effect.gen(function* () {
      const invoice = yield* attempt(() => ctx.db.get(input.id))
      if (!invoice) return yield* fail('NOT_FOUND')
      // ...
    }),
  ),
}),
```

- `fail('NOT_FOUND')` needs no `{}` when the code declares no details.
- `attempt` turns a thrown declared error, or a `ConvexError` carrying one of the
  contract's envelopes (as `ctx.runMutation` rethrows it), into a typed failure
  that `Effect.catchTag('DeclaredError', ...)` recovers. Other throws stay defects.
- A declared error thrown inside `Effect.gen` now keeps its code at the API
  boundary instead of becoming `UnknownFailure`, so a lint rule against throwing
  helpers inside `Effect.gen` is no longer needed for that reason.
- A registry whose `errors` is a `combineErrorContracts` result gets no factory
  helpers; use `effectErrors(memberContract)` for the member you raise from.

### 3. Failure audit — was: nothing recorded failed commands

Add the optional sink to the foundation. A failed mutation rolls back every
write, so `emit` logs; Convex log streams carry it to external telemetry:

```ts
export const foundation = createEffectFoundation({
  observability,
  writeAudit: (ctx, entry) => writeAuditEntry(ctx, entry),
  auditFailure: {
    emit: (entry) => console.warn(JSON.stringify({ event: 'operation.failed', ...entry })),
    errors: domainErrors, // the combined contract the API adapter already uses
  },
})
```

- Entries carry kind, operation, classification, declared code (or
  `UNKNOWN_FAILURE`), root and depth.
- Add `details` and `input` redactors only for fields that are safe to log.
- Each failure is reported once per request, by the innermost operation that
  failed.

### 4. Actions — was: ad-hoc `internalAction` handlers

Move a module's actions into one `foundation.Action` registry and keep the
Convex function as a thin adapter:

```ts
// foundation.ts
writeActionAudit: (ctx, entry) => ctx.runMutation(internal.audit.write, entry),

// domain/ecf/actions.ts
export const ecfActions = foundation.Action({
  contract: ecfContract, // declares `actions: { 'ecf.sign': { input, result } }`
  context: (ctx: ActionCtx) => ({ ctx, provider: dgiiProvider(ctx) }),
  audit: ({ operation, input }) => ({ operation, actorId: 'system', aggregate: { type: 'ecf', id: input.id } }),
  operations: ({ action, attempt, fail }) => ({
    'ecf.sign': action.handler((input, { ctx, provider }) =>
      Effect.gen(function* () {
        const signed = yield* attempt(() => provider.sign(input))
        if (!signed.ok) return yield* fail('ECF_INTEGRATION_FAILED', { code: signed.code, retryable: false })
        return yield* attempt(() => ctx.runMutation(internal.domain.ecf.internal.storeArtifact, signed.artifact))
      }),
    ),
  }),
})

// domain/ecf/internal.ts
export const sign = systemAction({
  args: signInput,
  handler: (ctx, args) => ecfActions.exec('ecf.sign', args, ctx),
})
```

- `classification` defaults to `'action'`.
- Actions have no `permission`, `prepare` or `expose`; authorize with a guard.
- An audited action without `writeActionAudit` fails before its handler runs.
- A failed audit write after the provider call returns the result and reports
  `ACTION_AUDIT_WRITE_FAILED`, so callers do not retry a submission that
  already happened.

## 0.1.6 — stricter architecture checks

Enable `project-structure`, `root-wiring-only`, `application-orchestration`,
`internal-function-ownership`, and `domain-file-responsibilities` alongside the
existing rules. These are opt-in additions; existing enabled boundary rules now
also resolve tsconfig aliases and reject migration dependencies.

Move root implementation folders into their owning domains. Keep `application/`
limited to multi-domain coordination. Move centralized domain tests beside their
owners and add real tests for nested executable directories. Do not create empty
scaffold files. Replace copied structural architecture suites with the packaged
checks; retain tests that exercise actual application behavior and wiring.

## 0.1.5 — consumer Oxlint rules

The initial 0.1.4 plugin incorrectly targeted this package's `src/` layout.
`cvx-kit/oxlint` now targets consuming applications under `convex/`, following
`conventions.md`. The six existing rule names remain, with consumer semantics;
nine additional rules cover builders, generated references, domain imports,
public adapters, facade ownership, vocabularies, reads, and timestamps.

Remove `entryPoints` and `packageName` options from your consumer lint config.
Applications have no barrel entry points inside `convex/`. Every rule now
accepts only an optional `convexDir`, relative to the linter's working directory
(default: `convex`). Enable the new rules explicitly; loading the plugin alone
does not enable them. See `oxlint.md` for coverage and the root README for a
complete configuration. Repository authoring checks remain local tooling.

No runtime API or storage migration is part of this correction.

## 0.1.4

This release introduced the optional `cvx-kit/oxlint` export. Its original
rules targeted library authoring; see the correction above for consumer use.

This patch tightens several TypeScript contracts during the anti-slop cleanup:

- Query middleware preserves the handler's result type. Return `next()` or
  throw; middleware that fabricates an unrelated result no longer typechecks.
- `include().execute` and `.paginate` require a transform callback when
  requesting a different output type through an explicit type argument.
- Audit metadata values must be serializable Convex `Value` values.
- Webhook targets must be internal mutation references accepting
  `{ eventKey: string, payload: string, source: string }`.
- CRUD enrichment derives from the table storage schema. Agent tools retain
  each supplied handler's input and result types.

Run your application's typecheck after upgrading and update affected callbacks.
No storage migration is required.

## 0.1.3

Install `convex-helpers` as a direct peer, using one compatible instance:

```sh
bun add cvx-kit@0.1.3 convex-helpers@0.1.124
```

The peer range was `>=0.1.123 <0.2.0`. Remove overrides that force a
separate helper copy and regenerate the installation without discarding
unrelated dependency choices. This release is validated with Convex 1.45.0,
Zod 4.5.4, and convex-test 0.0.56.

Existing `Command.operation` and `Command.middleware` remain available.
For callback inference, use `Command.withContext<MutationCtx>().operation`;
see `commands.md` for typed middleware and transactional completion.

Result transforms now run once, after middleware. A handler and middleware
return the result schema's **input** type; audit, completion, and the executor
receive its **output**. Middleware reading `await next()` sees the unparsed
handler result. Remove workarounds that compensate for double transforms.
When storing transformed outputs for replay, supply an output validator as
`replayResult`; otherwise replay uses the ordinary result schema.
Executor callers supply the command schema's input type; guards, prepare,
middleware, and handlers receive its parsed output. For example, a string
transformed to a number is passed as a string to the executor and observed
as a number by its callbacks.

Test registration no longer needs a registrar adapter or assertion:

```ts
import { convexTest } from 'convex-test'
import { registerFoundation, registerApprovals } from 'cvx-kit/test'
import schema from './schema'

const t = convexTest(schema, import.meta.glob('./**/*.ts'))
registerFoundation(t)
registerApprovals(t)
```

Both helpers accept an optional custom component path as their second argument.

## Approvals packaging repair (0.1.x patch)

`cvx-kit@0.1.0` published component schemas as `schema.mjs`, which Convex does
not discover for packaged components. Upgrade to the patch containing this
repair, remove any `patchedDependencies` entry that copied or renamed the
approvals schema, reinstall from a clean lockfile state, and run one normal
deployment:

```bash
bun install
bunx convex dev --once
```

The repaired package publishes only `schema.js` and `schema.d.ts` for each
component. Do not retain both `.mjs` and `.js`; Convex canonicalizes them to the
same module and rejects the deployment with `CanonicalizationConflict`.

This upgrade does not change table fields or index definitions, so a second
deployment is not required for staged index backfills. Existing deployments
that never received the component schema will create the tables and indexes on
the first repaired deployment. Confirm readiness through
`components.approvals.health.check` before resuming approval traffic.

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
	eventKey: (raw) => {
		const e = JSON.parse(raw)
		return `${e.event}:${e.id}:${e.updatedAt}`
	},
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
const withVendor = Command.middleware<Ctx, { vendor: Vendor }>(async ({ context, next }) =>
	next({ context: { vendor: await load(context) } }),
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
