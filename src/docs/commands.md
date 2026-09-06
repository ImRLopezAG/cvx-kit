# `cvx-kit/components/foundation` — the audited command protocol

The Foundation is a Convex component that **owns zero tables and zero
capability** — its schema is empty by design. What it provides is the
application kernel: the `Command` protocol (validate → observe → execute →
audit, in one transaction), the `Query` kernel, and payload-free
`Observability`. It is declared **once** per app and everything destructures
from it; there is no separate command import.

## Mounting and declaring

```ts
// convex/convex.config.ts
import { defineApp } from 'convex/server'
import foundation from 'cvx-kit/components/foundation/convex.config'

const app = defineApp()
app.use(foundation)
export default app
```

```ts
// convex/foundation.ts — declared once, the single kernel source
import { Foundation } from 'cvx-kit/components/foundation'
import { components } from './_generated/api'
import { writeAuditEntry } from './audit'

export const { Command, Query, observability } = new Foundation(
  components.foundation,
  {
    observability: {
      enabled: () => process.env.COMMAND_OBSERVABILITY_ENABLED === 'true',
      classifyError: (error) => classify(error), // → { outcome: 'denied' | 'failed', errorCode }
      writeAudit: (ctx, entry) => writeAuditEntry(ctx, entry),
    },
  },
)
```

Host code consumes the Foundation **only through this facade** — never deep
imports of the component's internal modules.

## Defining commands — per domain

Each domain declares a frozen registry of operations and derives typed
executors from it. `classification` and `audit()` are **mandatory per
operation** — auditing is type-enforced, not opt-in.

```ts
// convex/domain/documents/commands.ts
import { z } from 'zod'
import { Command } from '../../foundation'
import { documents } from './schema'
import { zid } from 'cvx-kit/zod-table'
import type { MutationCtx } from '../../_generated/server'

const typed = Command.withContext<MutationCtx>()

const operations = {
  'documents.rename': typed.operation({
    command: documents.commandInput.extend({ id: zid('documents') }),
    result: z.object({ ok: z.literal(true) }).strict(),
    classification: 'business',
    audit: ({ command }) => ({
      operation: 'documents.rename',
      actorId: command.actorId,
      aggregate: { type: 'document', id: command.id },
      metadata: { title: command.title },
    }),
  }),
} as const

const commands = new Command<MutationCtx, typeof operations>(operations)

export const executeRename = commands.exec({
  operation: 'documents.rename',
  handler: async (ctx, command) => {
    await ctx.db.patch(command.id, { title: command.title })
    return { ok: true }
  },
})
```

The public API layer then wraps the executor in an `authMutation` and passes
`ctx.actor` in. Public functions stay thin adapters; domain logic lives behind
`execute*` functions.

## What one execution does, in order

1. **Parse the command** through the operation's `command` schema (strict zod).
2. **Observe**: start the observation clock.
3. **Permission check** — if the operation declares `permission`, the
   Foundation's injected `checkPermission(ctx, { permission, operation })`
   runs; throw to deny. Declaring a permission with no injected checker
   **fails closed** (`COMMAND_PERMISSION_NOT_CONFIGURED`).
4. **Prepare**, when configured: obtain an invocation-local replay decision
   or completion closure. Replay validates its durable result, then goes
   directly to observation, skipping middleware, both guards, handler and audit.
5. **Middleware and guards** — registry middleware wraps operation middleware,
   which wraps both guards and the handler. The default guard is the
   registry-wide guard passed as the Command's second
   argument (`new Command(operations, { guard })`), if any.
   Then the operation's own `guard(ctx, command)` checks
   preconditions like state-machine legality, ownership beyond roles, or
   invariants over the parsed command. Throw to deny — nothing has run yet,
   so a denial is always clean.
6. **Run the handler and unwind middleware**; parse the final chain output
   through the `result` schema exactly once. Middleware sees schema inputs;
   audit, completion, and the executor receive validated schema outputs.
7. **Audit**: call the operation's `audit({ command, result }, ctx)`. If it
   returns non-null, the entry (plus the operation's `classification`) is
   written through the injected `writeAudit` — **in the same transaction** as
   the handler's writes. Returning `null` skips the audit (the ontology
   convention: failures are not audited). When the operation declares
   `aggregates: [...]`, an audit whose `aggregate.type` is not in that
   allowlist throws (`COMMAND_AGGREGATE_NOT_DECLARED`) — the audit
   vocabulary is enforced, not advisory. The per-operation catalog is
   introspectable as `commands.aggregates` for tests.
8. **Complete**: await the closure returned by `prepare`, including when audit
   returns null. A failure propagates inside the observation boundary.
9. **Emit the observation**: `{ operation, classification, outcome,
   errorCode?, durationMs }` — completed, denied, or failed per
   `classifyError`.

### Guards and permissions

```ts
// convex/foundation.ts — permission semantics are host policy, injected once
export const { Command, Query, observability } = new Foundation(
  components.foundation,
  {
    observability: { ... },
    checkPermission: (ctx, { permission }) =>
      requirePermission(ctx.identity, permission),   // throw to deny
  },
)

// domain/<module>/commands.ts
const operations = {
  '<entities>.publish': Command.operation({
    command: <entities>.commandInput.extend({ id: zid('<entities>') }),
    result: z.object({ ok: z.literal(true) }).strict(),
    classification: 'business',
    permission: '<domain>.manage',                    // checked first
    aggregates: ['<aggregate-type>'],                 // audit vocabulary allowlist
    guard: async (ctx, command) => {                  // precondition, pre-handler
      const row = await requireTenantReference(ctx.tenant, () => ctx.db.get(command.id))
      if (row.state !== 'draft') errors.throw({ code: 'INVALID_STATE' })
    },
    audit: ({ command }) => ({ ... }),
  }),
} as const

const commands = new Command<MutationCtx, typeof operations>(operations, {
  guard: (ctx) => assertNotReadonlyWindow(ctx),       // registry-wide default
})
```

Guards deny by throwing; a denial before the handler never needs rollback
because nothing has executed. Keep guards read-only — a guard that writes is
a handler in disguise.

### Middleware — composable, next()-based

For wrap-around concerns (timing, tracing, context enrichment) that two
disconnected callbacks can't express, both kernels take
Express/TanStack-style middleware. The chain runs **inside** the pipeline's
invariants: after the permission check, around [guards → handler], before the
result-schema parse, aggregate allowlist, and audit — so middleware can
never skip authorization, return an invalid result, or desynchronize audit
from effects.

```ts
const timing = Command.middleware(async ({ operation, next }) => {
  const started = Date.now()
  const result = await next()                       // inner middleware → guards → handler
  observability.observe // (or your own sink)
  console.info(`${operation} took ${Date.now() - started}ms`)
  return result
})

const withVendor = Command.middleware(async ({ context, next }) =>
  next({ context: { vendor: await loadVendor(context) } }))  // enriches downstream ctx

const commands = new Command<Ctx, typeof operations>(operations, {
  guard: (ctx) => assertNotReadonlyWindow(ctx),
  middleware: [timing],                             // registry-wide, outermost
})

'<entities>.publish': Command.operation({
  ...,
  middleware: [withVendor],                         // per-operation, inside registry chain
  guard: (ctx, command) => { /* ctx.vendor available here */ },
})
```

Order: registry middleware (array order) → operation middleware → default
guard → operation guard → handler. `next()` returns the downstream result;
`next({ context })` merges enrichment into the context handed to inner
middleware, guards, and the handler. Skipping `next()` short-circuits
(guards and handler never run — the returned value still must satisfy the
result schema); calling it twice throws `COMMAND_MIDDLEWARE_NEXT_REUSED`.
Whatever leaves the chain is parsed through the operation's strict result
schema — a middleware cannot fabricate an invalid result.

### Schema-inferred callbacks and context extensions (0.1.3)

`Command.withContext<Ctx>()` binds the host context for operation definitions.
Its `operation()` infers parsed command fields, validated audit result fields,
and the declared aggregate vocabulary. Operation middleware is contextual:
write inline callbacks without `Command.middleware`, whose legacy low-level
command and result boundary intentionally remains unknown.

```ts
const typed = Command.withContext<Ctx>()
const operations = {
  rename: typed.operation({
    command: z.object({ title: z.string().transform(value => value.length) }),
    result: z.object({ ok: z.boolean() }),
    classification: 'business',
    aggregates: ['document'],
    guard: (ctx, command) => requireTitleLength(ctx, command.title), // number
    middleware: [async ({ command, next }) => {
      const result = await next() // { ok: boolean }, before validation
      logLength(command.title)
      return result
    }],
    audit: ({ command, result }, ctx) => ({
      operation: 'rename', actorId: ctx.actorId,
      aggregate: { type: 'document', id: String(command.title) },
      metadata: { ok: result.ok },
    }),
  }),
}
const middleware = typed.registryMiddleware(operations, async input => {
  if (input.operation === 'rename') {
    input.command.title.toFixed() // discriminator retains schema correlation
  }
  return input.next()
})
const commands = new Command<Ctx, typeof operations>(operations, {
  middleware: [middleware],
})
```

Bind registry middleware to the same registry it describes. A heterogeneous
registry callback returns a union; narrowing `input.operation` preserves
the matching `input.command` and `input.next()` result type.
Reusing it with a different operation definition throws
`COMMAND_MIDDLEWARE_REGISTRY_MISMATCH` before the typed callback runs.

To propagate a required middleware extension to guards and handlers, use
`Command.withContext<Ctx, { traceId: string }>()`. Its operations require a
nonempty middleware tuple; the first layer must pass the declared extension
to `next({ context: { traceId } })` whenever it runs the downstream chain.
Later layers, guards and handlers see `Ctx & { traceId: string }`.
Audit and prepare receive the original context. The original context object
is not mutated. Short circuits still undergo final result validation.

### Transactional completion and replay (0.1.3)

Use `prepare(ctx, parsedCommand)` for host-owned idempotency. It runs after
permission and returns either `{ kind: 'replay', result: durableValue }` or
`{ kind: 'execute', complete: async validatedResult => { ... } }`.
The completion closure captures per-invocation state, including a fingerprint
derived from the parsed command and authenticated actor. Do not cache that
state in a shared context or module variable.

```ts
prepare: async (ctx, command) => {
  const key = scopedKey(ctx.actorId, command.idempotencyKey)
  const fingerprint = fingerprintOf(command)
  const receipt = await loadReceipt(ctx, key)
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw new Error('KEY_REUSED')
    return { kind: 'replay', result: receipt.result }
  }
  return {
    kind: 'execute',
    complete: async result => {
      await saveReceipt(ctx, { key, fingerprint, result })
    },
  }
},
```

Storage, actor/tenant scoping, fingerprint comparison, retention, and conflict
policy remain host responsibilities. Put authorization required on replay in
the injected permission checker or prepare lookup; both guards are skipped
on replay. A permission slug without a checker still fails closed. Ordinary
middleware short-circuiting is not this replay path and still audits.

Replays are parsed through `result` by default. If that schema transforms its
input, store the completion callback's validated output and supply
`replayResult` with an output validator (for example `z.number().int()` when
`result` transforms a string into a number). This prevents reapplying an input
transform to an already transformed durable result. An invalid replay fails
inside observation; successful replay does not invoke completion again.

Completion is awaited after result validation, audit resolution, aggregate
validation, and audit writing, even on audit-null paths. Errors from prepare,
replay validation, audit, or completion propagate and are passed to the host's
error classifier. Observation success means this command finished; the
enclosing mutation has not necessarily committed yet.

The Query kernel takes the same shape: `new Query({ defaults, middleware,
execute })` plus per-executor `middleware: [...]`, with `Query.middleware`
as the typing helper. Kernel middleware runs before executor middleware,
inside the host's injected `execute` policy.

For atomic rollback, let failures escape the enclosing Convex mutation.
Catching and swallowing a failure inside that mutation can commit earlier
business, audit, and completion writes. Rethrow after effects, or use the
effect-aware `executeResultBoundary` below. External I/O in actions is not
rolled back; these transaction guarantees concern Convex mutation writes.

### Dynamic dispatch

`exec` has a second overload for operation selection at runtime:

```ts
export const executeAny = commands.exec({
  dispatcher: z.object({ kind: z.enum(OPERATION_KINDS) /* from constants.ts */ }),
  select: (input) => `documents.${input.kind}` as const,
  handler,
})
```

An unconfigured operation throws `COMMAND_OPERATION_NOT_CONFIGURED`.

## Observability — payload-free by construction

Observations carry identifiers and a duration, never payloads. Events are
silently dropped unless:

- `enabled` resolves to `true`,
- `operation` and `classification` match `/^[A-Za-z][A-Za-z0-9_.-]{0,159}$/`,
- `errorCode` (when present) matches `/^[A-Z][A-Z0-9_]{0,95}$/`.

Practical consequence: **dotted lowercase operation names**
(`documents.rename`) and **UPPER_SNAKE error codes** are effectively
mandatory. Every telemetry path is wrapped in try/catch — observability is
behaviorally inert and can never change command behavior or mask the original
failure. Default sink is one JSON line on `console.info`
(`event: 'command.execution'`); inject `emit` to redirect.

## `executeResultBoundary` — typed failures, but only while it's safe

```ts
// destructured from the Foundation facade, like everything else
const { executeResultBoundary, projectResult } = new Foundation(...)

const result = await executeResultBoundary(ctx, () => run(), boundary)
// Result<Value, Failure> = { ok: true, value } | { ok: false, error }
```

Semantics — read carefully, they are decided by **transaction state**, not by
the error:

- Success → `{ ok: true, value }`.
- A failure the boundary recognizes (`dataOf(error)` non-undefined) is
  returned as `{ ok: false, error }` **only if the transaction has produced no
  effects yet** (nothing written, nothing scheduled — checked via
  `ctx.meta.getTransactionMetrics()`).
- If anything was already written or scheduled, the error is **rethrown** so
  Convex rolls the transaction back — a returned failure after effects would
  commit those effects.
- Unrecognized errors and unreadable metrics always rethrow.

Use it at the outermost edge of a mutation when the client needs a typed
`Result` over the wire instead of a thrown error. `projectResult(result,
onFailure)` unwraps on the caller side.

## The `Query` kernel

`Query` mirrors the pattern for reads: an injected `execute` receives
`{ context, metadata, run }`, letting the host apply uniform read policy
(authorization checks, tracing) around every domain query without the domains
knowing. Metadata defaults are set at construction and merged per-executor.

## Rules and footguns

1. One `new Foundation(...)` per app, in `convex/foundation.ts`. Everything
   else destructures from it.
2. Never deep-import the component's `modules/*` or `result.ts` paths from app
   code — the `client.ts` facade is the contract.
3. Use `Command.withContext<MutationCtx>()` for typed callbacks and construct
   the Command with a compatible host context. Legacy `Command.operation`
   keeps its low-level callback signature. Commands with writes run in mutations.
4. Name operations `domain.verb` and error codes `UPPER_SNAKE` or your
   telemetry silently disappears (see regexes above).
5. Keep operation registries frozen (`as const`) in the domain's
   `commands.ts`; vocabulary tuples live in `constants.ts`.
