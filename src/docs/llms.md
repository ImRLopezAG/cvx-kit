# cvx-kit — condensed reference for LLMs and coding agents

> Paste this file (installed at `node_modules/cvx-kit/docs/`) into an agent's
> context when it works on a cvx-kit application. Detailed docs:
> `architecture.md`, `conventions.md`, `zod-table.md`, `auth.md`,
> `commands.md`, `triggers.md`, `approvals.md`, `maintainability.md`,
> `migration.md` (same directory).
> Structure, file anatomy, and naming rules → `conventions.md` is
> authoritative. Restructuring an existing raw project → `migration.md`.

> **Placeholders.** Names like `documents`, `users`, `history`, `title`,
> `ownerId`, and `documentPublish` in the examples below are illustrative
> only — replace them with the application's own entities and fields. No
> specific table, entity, field, or workflow is required by the kit. Names in
> `<angle brackets>` are always placeholders.

cvx-kit is a reusable Convex application kit: zod table boundaries, auth-aware
function constructors, a trigger registry, an audited command protocol
(Foundation component), and a declarative approvals component. Peer deps:
`convex ^1.43`, `zod ^4`.

## Non-negotiable rules

1. **One `zodTable` per entity**, in `domain/<entity>/schema.ts`. Never write
   `defineTable` inline or a second zod object for the same entity.
2. **Raw `query`/`mutation`/`action`/`internal*` builders appear only in
   `convex/functions.ts`** (the `createAuthFunctions` call). All other
   functions use `authQuery/authMutation/authAction`, `roleQuery/...`,
   `adminQuery/...` (public) or `systemMutation/systemAction` (internal).
   This is what guarantees auth, triggers, and bounded reads.
3. **Every public query returns DTOs** via `<table>.toPublicDto(row)` —
   runtime redaction, not just types.
4. **Every read is bounded**: `ctx.include(ctx.db.query('t')).matching(...)
   .execute(limit)` with `1 ≤ limit ≤ 100`. `.resolve()` falls back to a full
   table scan — avoid it.
5. **State changes are commands**: an operations registry with mandatory
   `classification` and `audit()` per operation, executed via
   `commands.exec({ operation, handler })`. Audit writes happen in the same
   transaction.
6. **Never write timestamps by hand.** `createdAt`/`updatedAt` are maintained
   by the `timestamps` trigger; `archivedAt` is the app-controlled soft-delete
   marker.
7. **Vocabularies are named readonly tuples in `constants.ts`** —
   `z.enum([...])` with an inline literal is banned in kit-style codebases.
8. **Components are consumed only through their client facades**
   (`Foundation`, `Approvals`) — no deep imports, no touching component
   tables, no reaching private children (`components.approvals.workflow`).
9. **Operation names are `domain.verb` lowercase-dotted; error codes are
   UPPER_SNAKE** — otherwise observability silently drops the events.

## Exports map

| Import | Provides |
|---|---|
| `cvx-kit` | everything below re-exported (except components' defaults) |
| `cvx-kit/zod-table` | `zodTable`, `zodVariantTable`, `jsonSafeZid`, `TIMESTAMP_FIELDS` |
| `cvx-kit/auth` | `createAuthFunctions`, `createInclude`, `defaultRoleMap` |
| `cvx-kit/triggers` | `createTriggers`, `timestamps`, `appendOnly`, `noDelete`, `Triggers` |
| `cvx-kit/errors` | `KitError`, `defaultErrors`, `ErrorFactory` |
| `cvx-kit/components/foundation` | `Foundation`, `executeResultBoundary`, `projectResult`, `Observability`; default export = component config for `app.use` |
| `cvx-kit/components/approvals` | `Approvals` client; default export = component config for `app.use` |
| `cvx-kit/test` | `registerFoundation(t)`, `registerApprovals(t)` for convex-test |

## Minimal app wiring (the five root files)

```ts
// convex/convex.config.ts
import { defineApp } from 'convex/server'
import foundation from 'cvx-kit/components/foundation'
import approvals from 'cvx-kit/components/approvals'
const app = defineApp()
app.use(foundation)
app.use(approvals)
export default app

// convex/triggers.ts
import { createTriggers, timestamps, appendOnly } from 'cvx-kit/triggers'
export const triggers = createTriggers<DataModel>()
timestamps(triggers, 'documents')
appendOnly(triggers, 'history')

// convex/functions.ts
export const { authQuery, authMutation, authAction, adminQuery, adminMutation,
  adminAction, roleQuery, roleMutation, roleAction, systemMutation,
  systemAction, include } = createAuthFunctions<DataModel>({
  query, mutation, action, internalMutation, internalAction,   // from ./_generated/server
  getAuthUser: (ctx) => authKit.getAuthUser(ctx),
  mapRole: defaultRoleMap,          // 'member'→'writer'; reader|writer|admin pass
  adminRoles: ['admin'],
  triggers,
  verifyMembership: async ({ userId, organizationId }) => { /* live check; actions only */ },
})

// convex/foundation.ts
export const { Command, Query, observability } = new Foundation(
  components.foundation,
  { observability: {
      enabled: () => process.env.OBS === 'true',
      classifyError,                                  // → { outcome: 'denied'|'failed', errorCode }
      writeAudit: (ctx, entry) => writeAuditEntry(ctx, entry),
  } },
)

// convex/approvals.ts
export const approvals = new Approvals(components.approvals)
```

## Entity pattern

```ts
// domain/documents/schema.ts
export const documents = zodTable('documents', (id) => ({
  title: z.string(), ownerId: id('users'), secretNote: z.string(),
}), {
  commandFields: ['title'],            // what a command may say
  publicFields: ['title', 'ownerId'],  // the DTO allowlist
})

// convex/schema.ts (via domain/table.ts)
defineSchema({ documents: documents.table.index('by_owner', ['ownerId']) })

// domain/documents/commands.ts
const operations = {
  'documents.rename': Command.operation({
    command: documents.commandInput.extend({ id: zid('documents'), actorId: z.string() }),
    result: z.object({ ok: z.literal(true) }).strict(),
    classification: 'business',
    audit: ({ command }) => ({ operation: 'documents.rename', actorId: command.actorId,
      aggregate: { type: 'document', id: command.id } }),
  }),
} as const
const commands = new Command<MutationCtx, typeof operations>(operations)
export const executeRename = commands.exec({ operation: 'documents.rename',
  handler: async (ctx, cmd) => { await ctx.db.patch(cmd.id, { title: cmd.title }); return { ok: true } } })

// api/documents.ts — thin public adapter
export const rename = authMutation({
  args: documents.commandInput.extend({ id: zid('documents') }),
  returns: z.object({ ok: z.literal(true) }).strict(),
  handler: (ctx, args) => executeRename(ctx, { ...args, actorId: ctx.actor.userId }),
})
export const list = authQuery({
  args: { limit: z.number() },
  returns: z.array(documents.publicDto),
  handler: (ctx, { limit }) =>
    ctx.include(ctx.db.query('documents'))
      .matching('by_owner', (ix) => ix.eq('ownerId', ctx.actor.userId))
      .execute(limit, (rows) => rows.map(documents.toPublicDto)),
})
```

## Auth ctx contents

Authenticated handlers receive frozen `ctx.identity` (JWT), `ctx.user.id`,
`ctx.org = { organizationId, role }`, `ctx.role`, `ctx.actor = { userId,
organizationId, role }`, and `ctx.include`. Queries/mutations trust the JWT;
**actions live-verify membership and fail closed**. Use `ctx.actor` as the
canonical actor for audits/approvals.

## Approvals in one block

```ts
export const publishApproval = approvals.define({ name: 'documentPublish', steps: [
  approvals.decision('managerDecision', { decisions: ['approved','rejected'],
    quorum: { kind: 'count', approvals: 1 }, makerChecker: true, expiresAfterMs: 604_800_000 }),
  approvals.branch('applyDecision', { approvedStepKey: 'publish', rejectedStepKey: 'notify' }),
  approvals.mutation('publish', { handler: internal.domain.documents.approval_functions.applyDecision }),
  approvals.notify('notify', { handler: internal.domain.documents.approval_functions.notifyRejected }),
]})
// start(ctx, { scopeRef, resourceType, resourceRef, requester: ctx.actor, metadata? })
// decide(ctx, { runId, decision, reason? }, ctx.actor) · status/evidence/list/cancel/restart
```

Callback handlers are `systemMutation`/`systemAction`, receive opaque strings,
and must `normalizeId` + re-check `resourceType` + verify the resource still
points at `runId`.

## Footguns (top 8)

1. `t.run(ctx => ctx.db...)` in convex-test and raw builders bypass ALL
   triggers — seeding only.
2. `executeResultBoundary` returns a typed failure **only when the
   transaction has no effects yet**; after any write/schedule it rethrows for
   rollback. Handled-vs-thrown is decided by transaction state.
3. Observability drops events on identifier-regex mismatch — see rule 9.
4. Mis-declared `serverFields` silently make server-owned fields
   client-writable; masks are the security boundary.
5. `include(...).resolve()` silently falls back to `fullTableScan()`.
6. Audit callback ctx is untyped (`never`) — commands must run in mutations;
   wiring a query ctx fails at runtime.
7. Changing approval steps without bumping `compatibilityKey` lets old runs
   be driven by an incompatible shape.
8. When composing ctx manually, spread `wrapDB(ctx)` first — later spreads
   carrying `db` restore the unwrapped database.
