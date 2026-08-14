# `cvx-kit/tenancy` — row-level security, with tenancy as an opt-in layer

Row-level security and tenancy are **separate, composable features** of the
same `security` config on `createAuthFunctions`:

- **`security.rules` alone** — role-level / module-level RLS with no tenancy
  at all: gate writes by role, freeze evidence tables, ownership-gate reads.
  `defaultPolicy` stays `'allow'`; unlisted tables behave normally.
- **`security.tenancy` alone** — pure tenant isolation from a table registry.
- **Both** — rules are AND-composed with tenant isolation.

A single-org app that only wants role-gated writes configures `rules` and
never touches tenancy. Nothing below is required unless you opt into it.

Multi-tenancy itself is a structural machine, not a per-handler
convention. The model: **tenant = the identity provider's organization id**,
stamped as a server-owned `tenant` string field on every tenant-scoped row,
always derived from the verified identity — never accepted as an argument.
Isolation is defense-in-depth; each layer covers a hole in the previous one:

1. **Schema** — `tenantTable` injects the field and strips it from every
   write boundary.
2. **Row-level security** — deny-default rules generated mechanically from
   one table registry, wrapped into the auth constructors.
3. **Triggers** — a post-image invariant forbids tenant reassignment (RLS
   authorizes against the pre-image only).
4. **Reference guards** — client-supplied ids re-verify ownership without
   disclosing existence.

Single-org apps skip all of this: every piece is opt-in, and
`createAuthFunctions` without a `security` config behaves exactly as before.

## The registry is the design

One list of table names drives everything. Adding a table to the registry is
the entire onboarding — there is no second per-table step to forget:

```ts
// convex/tenancy.ts (or alongside triggers.ts)
export const TENANT_TABLES = ['<entities>', '<others>'] as const
```

- `security.tenancy.tables: TENANT_TABLES` → RLS rules generated per table
- `tenantOwnership(triggers, ...TENANT_TABLES)` → reassignment guard per table
- each listed table is declared with `tenantTable(...)` in its module

Recommended architecture test: assert every `tenantTable` in the codebase
appears in `TENANT_TABLES`, and vice versa.

## Wiring

```ts
// domain/<module>/schema.ts — tenant injected at the schema boundary
export const <entities> = tenantTable('<entities>', (id) => ({
  name: z.string(), ownerId: id('users'),
}), { publicFields: ['name'] })
// tenant: excluded from insertSchema/updateSchema/commandInput,
// in publicDto only if explicitly allowlisted

// domain/<module>/table.ts — every index tenant-prefixed
<entities>: <entities>.table.index('by_tenant', ['tenant'])
                            .index('by_tenant_owner', ['tenant', 'ownerId'])

// convex/triggers.ts
tenantOwnership(triggers, ...TENANT_TABLES)

// convex/functions.ts
createAuthFunctions<DataModel>({
  ...,
  security: {
    tenancy: {
      tables: TENANT_TABLES,
      // optional; defaults to bundle.org.organizationId
      resolve: (bundle) => bundle.org.organizationId,
    },
    // role-level security, AND-composed with tenant isolation
    rules: (bundle) => ({
      '<entities>': { modify: async () => bundle.role === '<privileged>' },
    }),
    // defaults to 'deny' when tenancy is configured
    defaultPolicy: 'deny',
  },
})
```

## What the constructors do with it

- Every authenticated ctx gains **`ctx.tenant`** (also on the frozen bundle) —
  resolved via `security.tenancy.resolve`, defaulting to the organization id.
  Actions re-derive it from the live-verified membership.
- **Queries** get a wrapped reader: rows failing `read` are invisible —
  filtered from every `get`/`query`, even a full table scan.
- **Mutations** wrap triggers first, then the RLS writer — `insert`/`modify`
  failing a rule throws. Order matters and is handled for you.
- **`system*` constructors stay unwrapped** — trusted internal paths reach
  every table. This is deliberate: schedulers and callbacks receive the
  server-derived tenant as data, never as authority.
- With tenancy configured, `defaultPolicy` defaults to **deny**: tables
  outside the registry are unreachable from `auth*`/`role*`/`admin*`
  functions. Global/platform tables are reached from `system*` paths, or by
  explicitly granting rules for them.

Handlers stamp inserts from the ctx — the schema forbids clients supplying
it, RLS rejects a wrong value, and the trigger forbids changing it later:

```ts
await ctx.db.insert('<entities>', { ...args, tenant: ctx.tenant })
```

## Role-level security — with or without tenancy

`security.rules` receives the full auth bundle and returns convex-helpers
`Rules`. It works standalone (no tenancy configured) or AND-composed with
tenant isolation (`composeRules`) — a row must pass **every** rule set that
defines the operation. Use it for role-gated writes, ownership-gated reads,
or state-machine write locks:

```ts
// rules-only, single-org app: no tenancy anywhere
security: {
  rules: (bundle) => ({
    '<entities>': { modify: async () => bundle.role !== '<readonly-role>' },
  }),
}
```

```ts
rules: (bundle) => ({
  '<entities>': {
    modify: async (_ctx, doc) =>
      bundle.role === 'admin' || doc.ownerId === bundle.actor.userId,
  },
  '<evidence>': { modify: async () => false },   // frozen via RLS as well as trigger
})
```

## Client-supplied ids

RLS makes foreign rows invisible to reads, but any id a client sends should
still be re-verified — and without disclosing existence:

```ts
import { requireTenantReference } from 'cvx-kit/tenancy'

const row = await requireTenantReference(ctx.tenant, () => ctx.db.get(args.id))
// missing row and foreign row fail identically: REFERENCE_NOT_FOUND
```

`assertTenantOwned(tenant, doc)` is the internal-path variant
(CROSS_TENANT_REFERENCE, for rows you already loaded on trusted paths).

## Footguns

1. **Actions have no db** — an action passing work to internal functions must
   pass `ctx.tenant` (server-derived) as data; internal functions must never
   accept a caller-chosen tenant on a public path.
2. **Provider ids are global** (memberships, invitations in WorkOS-style
   providers): org-scoped mutations against the provider must re-check the
   id belongs to the active org, or you ship a cross-tenant IDOR.
3. **Tables outside the registry get none of this.** Keep the global-table
   list short and named; every one is a per-handler-discipline zone.
4. **`t.run(...)` in convex-test bypasses RLS and triggers** — same rule as
   always: seeding only.
5. **Return "not found", never "forbidden"** for cross-tenant references —
   existence is also tenant data.

## Module maps

`createModule` (from `cvx-kit/zod-table`) merges per-module table maps into
the schema and rejects a table declared by two modules:

```ts
// convex/domain/table.ts
export const domainTables = createModule(
  <moduleA>Tables, <moduleB>Tables, <moduleC>Tables,
)
// convex/schema.ts
export default defineSchema(domainTables)
```
