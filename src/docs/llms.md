# cvx-kit — condensed reference for LLMs and coding agents

> Paste this file (installed at `node_modules/cvx-kit/docs/`) into an agent's
> context when it works on a cvx-kit application. Detailed docs:
> `architecture.md`, `conventions.md`, `zod-table.md`, `auth.md`,
> `commands.md`, `effect.md`, `domain-operations.md`, `triggers.md`, `approvals.md`, `maintainability.md`,
> `migration.md` (same directory).
> Structure, file anatomy, and naming rules → `conventions.md` is
> authoritative. Restructuring an existing raw project → `migration.md`.
> Upgrading from 0.0.x → `upgrading.md`. New 0.1.0 helpers: `crud.md`,
> `webhooks.md`, `agent-tools.md`; pagination in `zod-table.md`/`auth.md`.
> Consumer lint configuration and coverage → `oxlint.md`. The optional
> `cvx-kit/oxlint` plugin checks the statically detectable conventions;
> behavioral guarantees still need architecture and runtime tests.

> **Placeholders.** Names like `documents`, `users`, `history`, `title`,
> `ownerId`, and `documentPublish` in the examples below are illustrative
> only — replace them with the application's own entities and fields. No
> specific table, entity, field, or workflow is required by the kit. Names in
> `<angle brackets>` are always placeholders.

cvx-kit is a reusable Convex application kit: zod table boundaries, auth-aware
function constructors, a trigger registry, an audited command protocol
(Foundation component), and a declarative approvals component. Peer deps:
`convex ^1.45.0`, `zod ^4.5.4`; command implementations also install
`effect >=4.0.1 <5` and import `cvx-kit/effect`.

**Command API selection:** use `createEffectFoundation` and declare handlers
inside `command({...})`. The older `Foundation.Command` Promise facade is
deprecated. Its compatibility examples live in `commands-legacy.md`; do not
copy that API into new implementations.

## Non-negotiable rules

1. **One `zodTable` per entity**, in `domain/<entity>/schema.ts`. Never write
   `defineTable` inline or a second zod object for the same entity.
2. **Raw `query`/`mutation`/`action`/`internal*` builders appear only in
   `convex/functions.ts`** (the `createAuthFunctions` call). All other
   functions use `authQuery/authMutation/authAction`, `roleQuery/...`,
   `adminQuery/...` (public) or `systemQuery/systemMutation/systemAction` (internal),
   wrapped once with `effectZodApiBuilder` when their handlers return Effects.
   This is what guarantees auth, triggers, and bounded reads.
3. **Every public query returns DTOs** via `<table>.toPublicDto(row)` —
   runtime redaction, not just types.
4. **Every read is bounded**: `ctx.include(ctx.db.query('t')).matching(...)
.execute(limit)` with `1 ≤ limit ≤ 100`. `.resolve()` falls back to a full
   table scan — avoid it.
5. **State changes are Effect commands**: declare
   `Command({ context, operations: ({ command }) => ({ ... }), defaults })`.
   Each `command({ input, result, classification, handler, audit })` owns its
   handler; handlers receive `(input, context)`. Execute with
   `commands.exec(operation, input, host)` and return the lazy Effect through a
   shared API builder. Never pass a handler to `exec` or run a nested
   `Effect.runPromise`. Permission uses the injected `checkPermission(host, ...)`;
   guards receive `(context, input)`. Per-operation middleware is one callback,
   `next()` returns an Effect, and `next({ context })` enriches downstream ctx.
   Order: input → context → permission → prepare/replay → middleware → default
   guard → operation guard → handler → result parse → aggregates/audit → completion.
   Audit writes stay in the mutation transaction. Failures must escape the
   mutation for rollback; replay skips middleware, guards, handler, and audit.
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
10. **Row-level security is configured, not hand-rolled**: the optional
    `security` config on `createAuthFunctions` takes role-level `rules`
    (works standalone) and/or `tenancy` (a table registry; adds
    `ctx.tenant`, deny-default isolation, and pairs with `tenantTable` +
    `tenantOwnership`). Multi-tenant apps stamp inserts with
    `tenant: ctx.tenant` and re-verify client ids with
    `requireTenantReference`. See `tenancy.md`.

## Exports map

| Import                          | Provides                                                                                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cvx-kit`                       | Non-Effect helpers and component clients; import the optional Effect facade explicitly from `cvx-kit/effect`. |
| `cvx-kit/zod-table`             | `zodTable`, `tenantTable`, `createModule`, `paginated`, `zodVariantTable`, `jsonSafeZid`, `TIMESTAMP_FIELDS`                                                                                                                                                            |
| `cvx-kit/effect`                | Recommended command/query API: `createEffectFoundation`, `effectApiBuilder`, `effectZodApiBuilder`, `createEffectCrud`, idempotency/workflow adapters and operation tools. |
| `cvx-kit/auth`                  | `createAuthFunctions` (incl. optional `security` RLS config), `createInclude`, `defaultRoleMap`                                                                                                                                                                         |
| `cvx-kit/tenancy`               | `createTenantRules`, `composeRules`, `requireTenantReference`, `assertTenantOwned`, `TENANT_FIELD`                                                                                                                                                                      |
| `cvx-kit/crud`                  | Compatibility CRUD factory using the deprecated Promise command facade; use `createEffectCrud` from `cvx-kit/effect` for new domains. |
| `cvx-kit/state-machine`         | `createStateMachine` — typed transitions from constants tuples; `assert` drops into command guards                                                                                                                                                                      |
| `cvx-kit/middleware`            | `rateLimit` — packaged middleware over an injected rate-limiter instance; keyed by `ctx.tenant`, missing key = config error                                                                                                                                             |
| `cvx-kit/webhooks`              | `createWebhookBoundary`, `recordWebhookEvent`, `webhookEventsTable` — raw-body verify, natural-key dedup in the mutation                                                                                                                                                |
| `cvx-kit/agent-tools`           | `createAgentTools` — tool records from table masks; mutation handlers route through command executors                                                                                                                                                                   |
| `cvx-kit/triggers`              | `createTriggers`, `timestamps`, `appendOnly`, `noDelete`, `tenantOwnership`, `Triggers`                                                                                                                                                                                 |
| `cvx-kit/errors`                | `KitError`, `defaultErrors`, `ErrorFactory`                                                                                                                                                                                                                             |
| `cvx-kit/components/foundation` | Component client and types; `Foundation.Command` is deprecated. The component and other capabilities remain available. New command registries use `cvx-kit/effect`. |
| `cvx-kit/components/approvals`  | `Approvals` client; default export = component config for `app.use`                                                                                                                                                                                                     |
| `cvx-kit/test`                  | `registerFoundation(t)`, `registerApprovals(t)` for convex-test                                                                                                                                                                                                         |

## Minimal app wiring (the five root files)

```ts
// convex/convex.config.ts
import { defineApp } from 'convex/server'
import foundation from 'cvx-kit/components/foundation/convex.config'
import approvals from 'cvx-kit/components/approvals/convex.config'
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
export const {
	authQuery,
	authMutation: baseAuthMutation,
	authAction,
	adminQuery,
	adminMutation,
	adminAction,
	roleQuery,
	roleMutation,
	roleAction,
	systemQuery,
	systemMutation,
	systemAction,
	include,
} = createAuthFunctions<DataModel>({
	query,
	mutation,
	action,
	internalQuery,
	internalMutation,
	internalAction, // from ./_generated/server
	getAuthUser: (ctx) => authKit.getAuthUser(ctx),
	mapRole: defaultRoleMap, // 'member'→'writer'; reader|writer|admin pass
	adminRoles: ['admin'],
	triggers,
	verifyMembership: async ({ userId, organizationId }) => {
		/* live check; actions only */
	},
	resolveOrganization: async ({ ctx, identity, user }) => {
		/* org+role from app tables; overrides claims; null/throw ⇒ FORBIDDEN */
	},
})

// convex/functions.ts — wrap configured auth constructors once, after auth/RLS/triggers
// Import Context from effect and effectZodApiBuilder from cvx-kit/effect.
// Place this after the registry declaration or import the registry from its module.
export const authMutation = effectZodApiBuilder(baseAuthMutation, {
	context: (ctx) => ({ commands: commands.withContext(ctx) }),
})

// convex/foundation.ts
// Import createEffectFoundation from cvx-kit/effect.
import type { MutationCtx } from './_generated/server'
export type CommandHost = MutationCtx & { actor: { userId: string } }
export const { Command, Query, observability } = createEffectFoundation({
	observability: {
		enabled: () => process.env.OBS === 'true',
		classifyError, // → { outcome: 'denied'|'failed', errorCode }
	},
	writeAudit: (ctx: CommandHost, entry) => writeAuditEntry(ctx, entry),
})

// convex/approvals.ts
export const approvals = new Approvals(components.approvals)
```

## Entity pattern

```ts
// domain/documents/schema.ts
export const documents = zodTable(
	'documents',
	(id) => ({
		title: z.string(),
		ownerId: id('users'),
		secretNote: z.string(),
	}),
	{
		commandFields: ['title'], // what a command may say
		publicFields: ['title', 'ownerId'], // the DTO allowlist
	},
)

// convex/schema.ts (via domain/table.ts)
defineSchema({ documents: documents.table.index('by_owner', ['ownerId']) })

// domain/documents/commands.ts
export const renameInput = documents.commandInput.extend({ id: zid('documents') })
export const renameResult = z.object({ ok: z.literal(true) }).strict()
export const commands = Command({
	context: (host: CommandHost) => host,
	operations: ({ command }) => ({
		'documents.rename': command({
			input: renameInput,
			result: renameResult,
			classification: 'business',
			handler: async (input, ctx) => {
				await ctx.db.patch(input.id, { title: input.title })
				return { ok: true as const }
			},
			audit: ({ command }, ctx) => ({
				operation: 'documents.rename',
				actorId: ctx.actor.userId,
				aggregate: { type: 'document', id: command.id },
			}),
		}),
	}),
})

// api/documents.ts — thin public adapter
export const rename = authMutation({
	args: renameInput,
	returns: renameResult,
	handler: (ctx, input) => ctx.commands.exec('documents.rename', input),
})
export const list = authQuery({
	args: { limit: z.number() },
	returns: z.array(documents.publicDto),
	handler: (ctx, { limit }) =>
		ctx
			.include(ctx.db.query('documents'))
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
export const publishApproval = approvals.define({
	name: 'documentPublish',
	steps: [
		approvals.decision('managerDecision', {
			decisions: ['approved', 'rejected'],
			quorum: { kind: 'count', approvals: 1 },
			makerChecker: true,
			expiresAfterMs: 604_800_000,
		}),
		approvals.branch('applyDecision', { approvedStepKey: 'publish', rejectedStepKey: 'notify' }),
		approvals.mutation('publish', {
			handler: internal.domain.documents.approval_functions.applyDecision,
		}),
		approvals.notify('notify', {
			handler: internal.domain.documents.approval_functions.notifyRejected,
		}),
	],
})
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
6. Command audit actors come from trusted host context, never client input.
   Commands with writes must run through mutation builders with wrapped `ctx.db`.
7. Changing approval steps without bumping `compatibilityKey` lets old runs
   be driven by an incompatible shape.
8. When composing ctx manually, spread `wrapDB(ctx)` first — later spreads
   carrying `db` restore the unwrapped database.

Optional request context can be added through the existing Effect API adapter's
`context` callback. Bind selected registries with `commands.withContext(value)`
and consume `ctx.commands.exec(name, input)` through the application's existing
function helper names. Keep dependencies local to each feature; explicit execution
and input-only command handlers remain supported. See [optional context injection](./command-context.md).
