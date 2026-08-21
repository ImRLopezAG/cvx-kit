# `cvx-kit/auth` — auth-aware function constructors from injected policy

`createAuthFunctions` builds the function constructors your whole backend uses
in place of raw `query`/`mutation`/`action`. Nothing in the kit imports your
app's singletons — identity resolution, role vocabulary, membership
verification, trigger wrapping, and error policy are all **injected** by the
host. The kit provides the structure; the app provides the policy.

## Setup — declared once per app

```ts
// convex/functions.ts (the single place constructors are built)
import { createAuthFunctions, defaultRoleMap } from 'cvx-kit/auth'
import {
  action, internalAction, internalMutation, internalQuery, mutation, query,
} from './_generated/server'
import type { DataModel } from './_generated/dataModel'
import { triggers } from './triggers'
import { authKit } from './auth'

export const {
  authQuery, authMutation, authAction,
  roleQuery, roleMutation, roleAction,
  adminQuery, adminMutation, adminAction,
  systemQuery, systemMutation, systemAction,
  include, authenticatedUser,
} = createAuthFunctions<DataModel>({
  query, mutation, action, internalQuery, internalMutation, internalAction,
  getAuthUser: (ctx) => authKit.getAuthUser(ctx),
  mapRole: defaultRoleMap,          // or your own vocabulary (see below)
  adminRoles: ['admin'],
  triggers,                          // every mutation write runs through wrapDB
  verifyMembership: async ({ userId, organizationId }) => {
    const memberships = await authKit.workos.userManagement
      .listOrganizationMemberships({ organizationId, userId, statuses: ['active'] })
    const m = memberships.data.find((c) => c.userId === userId)
    return m ? { organizationId: m.organizationId, roleSlug: m.role.slug } : null
  },
})
```

Every function in the app is then built from these — raw `query`/`mutation`
imports from `_generated/server` appear **only** in this file.

## The constructor families

| Constructor | Visibility | Auth | Extra |
|---|---|---|---|
| `authQuery` / `authMutation` / `authAction` | public | any authenticated org member | actions live-verify membership |
| `roleQuery(...roles)` / `roleMutation(...)` / `roleAction(...)` | public | listed roles only | factory — call with your roles |
| `adminQuery` / `adminMutation` / `adminAction` | public | `config.adminRoles` | pre-built `role*(...adminRoles)` |
| `systemQuery` | internal | none (trusted caller) | include-equipped, RLS-unwrapped |
| `systemMutation` | internal | none (trusted caller) | still trigger-wrapped |
| `systemAction` | internal | none | plain internal action |

All are `zCustom*` constructors from convex-helpers, so `args` and `returns`
take zod schemas directly and compose with `zodTable` masks.

## What handlers receive on `ctx`

Authenticated constructors extend the ctx with a frozen auth bundle:

- `ctx.identity` — the raw `UserIdentity` (JWT claims)
- `ctx.user.id` — the synchronized principal id (from `getAuthUser`)
- `ctx.org` — `{ organizationId, role }`
- `ctx.role` — the mapped role
- `ctx.actor` — `{ userId, organizationId, role }` — pass this to audits,
  approvals, and commands as the canonical actor reference
- `ctx.include` — the bounded query builder (below)

`systemQuery` and `systemMutation` get `include` (plus trigger wrapping for the
mutation) but no auth bundle.

## Role vocabulary is per-app

`mapRole` maps the identity's role slug onto **your** role union; returning
`null` rejects with `FORBIDDEN`, so unknown roles never pass. The default
(`defaultRoleMap`) is WorkOS-flavored: `member → writer`, and
`reader`/`writer`/`admin` pass through.

Supply your own vocabulary via the generic:

```ts
createAuthFunctions<DataModel, 'viewer' | 'editor' | 'owner'>({
  mapRole: (slug) => (slug === 'owner' ? 'owner' : slug === 'editor' ? 'editor' : slug ? 'viewer' : null),
  adminRoles: ['owner'],
  ...
})
```

## Queries/mutations trust the JWT; actions re-verify

Queries and mutations read org and role from the identity token. Actions —
which can run long and call third parties — additionally call
`verifyMembership` **live** before the handler runs, and the fresher
role/organization from that check replaces the JWT's. Verification **fails
closed**: any error or org mismatch throws `FORBIDDEN`. Omit
`verifyMembership` to let actions trust the JWT like queries do.

## Resolving org/role from the database (`resolveOrganization`)

Some identity providers issue tokens that carry **no org claims** — custom
credentials, magic codes, or apps that keep memberships in their own tables.
For those, configure `resolveOrganization` to derive organization authority
from the app's own data instead of the JWT.

When configured, the hook is the organization authority — claim parsing is
skipped entirely. Returning `null` **or throwing** rejects with `FORBIDDEN`
(fail closed); a missing identity or user is still `UNAUTHENTICATED`; the
returned `roleSlug` still passes through `mapRole` like a claim would.

The handler must be **action-safe**: in actions the ctx has no `db`, so branch
on its presence and fall back to an internal query:

```ts
resolveOrganization: async ({ ctx, user }) => {
  const membership =
    'db' in ctx
      ? await ctx.db
          .query('companyUsers')
          .withIndex('by_user', (q) => q.eq('userId', user.id))
          .first()
      : await ctx.runQuery(internal.memberships.byUser, { userId: user.id })
  if (!membership || !membership.active) return null   // revoked ⇒ FORBIDDEN
  return { organizationId: membership.orgId, roleSlug: membership.roleSlug }
},
```

Resolver obligations:

- Bind the lookup to the **verified** user — `user.id` (or
  `identity.subject`), never a caller-influenced or non-unique attribute.
- Resolve revoked/inactive/expired memberships to `null`, so revocation
  actually takes effect fail-closed.

Composition: `mapRole` still applies to the returned slug; with tenancy
configured, `ctx.tenant` derives from the hook's org
(`security.tenancy.resolve` is unchanged); `verifyMembership` for actions is
unchanged and receives the hook-resolved `organizationId` — in actions its
live result supersedes the hook's role/org, exactly as it supersedes claims.

Cost: one DB read per authenticated call (claims are free); actions with
`verifyMembership` configured also pay the live check. When debugging, note
that a misconfigured hook surfaces as blanket `FORBIDDEN` — errors are
swallowed fail-closed, never rethrown.

## Mutations are structurally trigger-wrapped

When `triggers` (or `wrapDB`) is configured, every `authMutation`,
`roleMutation`, and `systemMutation` runs its writes through
`triggers.wrapDB(ctx)`. Trigger enforcement (timestamps, append-only,
no-delete, denormalization) is therefore **structural** — a handler cannot
forget it, because it never sees an unwrapped `ctx.db`. This is the reason raw
`mutation` must not be used outside `functions.ts`.

## `include()` — every read is bounded

`include` wraps a table query in a fluent selector that (a) picks the first
matching indexed query and (b) refuses unbounded reads. `execute(limit)`
rejects limits outside `1..maxRows` (default 100, configurable via
`maxIncludedQueryRows`).

```ts
export const list = authQuery({
  args: { ownerId: zid('users').optional(), limit: z.number() },
  returns: z.array(documents.publicDto),
  handler: (ctx, args) =>
    ctx.include(ctx.db.query('documents'))
      .when(args.ownerId, (q, ownerId) =>
        q.withIndex('by_owner', (ix) => ix.eq('ownerId', ownerId)))
      .otherwise((q) => q.withIndex('by_owner'))
      .execute(args.limit, (rows) => rows.map(documents.toPublicDto)),
})
```

Selector methods:

- `.when(value, select)` — if `value` is non-null and nothing selected yet,
  use `select(query, value)`.
- `.matching(indexName, range?, shouldMatch?)` — index selection with an
  optional guard boolean.
- `.otherwise(select)` — fallback, returns the raw `Query`.
- `.resolve()` — selected query or full table scan (escape hatch).
- `.execute(limit, transform?)` — bounded `take` + optional projection. This
  is the normal terminal.

## Row-level security and tenancy (optional)

The `security` config adds structural RLS to every `auth*`/`role*`/`admin*`
constructor — role-level rules (`security.rules`, standalone), tenant
isolation from a table registry (`security.tenancy`, opt-in), or both
AND-composed. Queries get a wrapped reader; mutations wrap triggers first,
then the RLS writer; `system*` stays unwrapped. With tenancy configured, ctx
gains `ctx.tenant` (actions re-derive it from live verification). Full
treatment: `tenancy.md`.

## Errors

All rejections go through the injected `ErrorFactory` (default: throws
`KitError` with codes `UNAUTHENTICATED`, `FORBIDDEN`,
`INVALID_REQUEST_BOUNDARY`). Hosts with their own error taxonomy adapt it:

```ts
errors: { throw: (input) => { throw App.errors.from(input) } }
```

## Rules of thumb

1. Build constructors once in `convex/functions.ts`; import them everywhere
   else. Raw `_generated/server` builders appear nowhere else.
2. Public functions: `auth*`/`role*`/`admin*`. Scheduled/internal work:
   `system*`. Never expose an unauthenticated public function unless it is
   deliberately anonymous (and then document why).
3. Reads go through `ctx.include(...)` with an explicit limit.
4. Use `ctx.actor` as the actor reference in audits and approvals — never
   re-derive identity in a handler.
