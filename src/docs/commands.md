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

const operations = {
  'documents.rename': Command.operation({
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
4. **Default guard** — the registry-wide guard passed as the Command's second
   argument (`new Command(operations, { guard })`), if any.
5. **Operation guard** — the operation's own `guard(ctx, command)`:
   preconditions like state-machine legality, ownership beyond roles, or
   invariants over the parsed command. Throw to deny — nothing has run yet,
   so a denial is always clean.
6. **Run the handler**; its return value is parsed through the `result` schema
   — outputs are validated too.
7. **Audit**: call the operation's `audit({ command, result }, ctx)`. If it
   returns non-null, the entry (plus the operation's `classification`) is
   written through the injected `writeAudit` — **in the same transaction** as
   the handler's writes. Returning `null` skips the audit (the ontology
   convention: failures are not audited). When the operation declares
   `aggregates: [...]`, an audit whose `aggregate.type` is not in that
   allowlist throws (`COMMAND_AGGREGATE_NOT_DECLARED`) — the audit
   vocabulary is enforced, not advisory. The per-operation catalog is
   introspectable as `commands.aggregates` for tests.
8. **Emit the observation**: `{ operation, classification, outcome,
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

If any step throws, the Convex transaction rolls back — handler writes and
audit entry together. Audit and effects can never disagree.

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
3. The audit callback receives the ctx untyped (`never`); wiring a query ctx
   into an audited command fails at runtime, not compile time. Commands run in
   mutations.
4. Name operations `domain.verb` and error codes `UPPER_SNAKE` or your
   telemetry silently disappears (see regexes above).
5. Keep operation registries frozen (`as const`) in the domain's
   `commands.ts`; vocabulary tuples live in `constants.ts`.
