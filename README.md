# cvx-kit

[![CI](https://github.com/ImRLopezAG/cvx-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/ImRLopezAG/cvx-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/cvx-kit)](https://www.npmjs.com/package/cvx-kit)

Reusable Convex application kit: foundation kernels, a generic approvals
component, zod table boundaries, auth-aware function constructors with
per-app role vocabularies, an application trigger registry, and an audited
command protocol.

```sh
bun add cvx-kit
# or: npm install cvx-kit
```

## Toolchain

- `bun install` — dependencies
- `bun run test` — vite-plus test suite (`vp test run`, convex-test on edge-runtime)
- `bun run typecheck` — `tsc --noEmit`
- `bun run build` — `vp pack` (tsdown on Rolldown); all build options live in
  the `pack` key of `vite.config.ts`: per-module ESM + `.d.mts` to `dist/`,
  target ES2025, minified, deps external, publint-verified
- `bun run build:codegen` — re-run `convex codegen` for both components, then build

## Documentation

Full docs ship with the package — `node_modules/cvx-kit/docs/` when installed,
authored in [`src/docs/`](./src/docs/):

- [`architecture.md`](./src/docs/architecture.md) — the layered application shape the kit encodes
- [`conventions.md`](./src/docs/conventions.md) — the doctrine: folder structure, file anatomy, naming grammar, import rules
- [`zod-table.md`](./src/docs/zod-table.md) — one zod shape per entity, masked into every boundary
- [`auth.md`](./src/docs/auth.md) — auth-aware function constructors from injected policy
- [`commands.md`](./src/docs/commands.md) — Foundation, the audited command protocol, observability
- [`triggers.md`](./src/docs/triggers.md) — trigger registry, timestamps/append-only/no-delete
- [`approvals.md`](./src/docs/approvals.md) — declarative approval workflows
- [`maintainability.md`](./src/docs/maintainability.md) — keeping a Convex app maintainable long-term
- [`migration.md`](./src/docs/migration.md) — restructuring an existing raw Convex project into this architecture
- [`llms.md`](./src/docs/llms.md) — condensed reference to paste into an LLM/agent context

## Modules

### `cvx-kit/zod-table`

One zod shape per entity, masked into every boundary it crosses:

```ts
import { zodTable } from 'cvx-kit/zod-table'

export const documents = zodTable(
  'documents',
  (id) => ({
    title: z.string(),
    ownerId: id('users'),
    secretNote: z.string(),
  }),
  {
    commandFields: ['title'],           // what a command may say
    publicFields: ['title', 'ownerId'], // the DTO allowlist
  },
)
// documents.table → defineTable(...) for schema.ts
// documents.toPublicDto(row) → projects AND re-parses (runtime redaction)
```

Every table gets `createdAt`, `updatedAt`, and `archivedAt` baked in —
opinionated, server-owned, always excluded from inserts and commands
(expose them via `publicFields` when a DTO needs them). Register the
`timestamps` trigger once and they maintain themselves; `archivedAt` stays
under application control.

`zodVariantTable` covers discriminated-union tables; `jsonSafeZid` keeps
LLM-tool JSON schemas primitive while preserving the `Id<...>` type.

### `cvx-kit/auth`

`createAuthFunctions` builds the six auth-aware constructors from injected
policy — nothing in the kit imports your app's singletons:

```ts
import { createAuthFunctions } from 'cvx-kit/auth'
import { action, internalAction, internalMutation, mutation, query } from './_generated/server'

export const { authQuery, authMutation, authAction, adminQuery, adminMutation,
  adminAction, systemMutation, systemAction, include } =
  createAuthFunctions<DataModel>({
    query, mutation, action, internalMutation, internalAction,
    getAuthUser: (ctx) => authKit.getAuthUser(ctx),
    verifyMembership: async ({ userId, organizationId }) => {
      const memberships = await authKit.workos.userManagement
        .listOrganizationMemberships({ organizationId, userId, statuses: ['active'] })
      const m = memberships.data.find((c) => c.userId === userId)
      return m ? { organizationId: m.organizationId, roleSlug: m.role.slug } : null
    },
    wrapDB: (ctx) => triggers.wrapDB(ctx),
  })
```

Actions re-verify membership live and fail closed; mutations get the trigger
registry structurally; `include()` bounds every read (default 100 rows).

### `cvx-kit/components/foundation`

Declared once; everything destructures from it. `Command` comes out of the
Foundation already bound to observability and the audit writer — there is no
separate command import.

```ts
// convex/convex.config.ts
import foundation from 'cvx-kit/components/foundation'
app.use(foundation)

// convex/foundation.ts — declared once, the single kernel source
import { Foundation } from 'cvx-kit/components/foundation'
export const { Command, Query, observability } = new Foundation(
  components.foundation,
  {
    observability: {
      enabled: () => env.OBS === 'true',
      classifyError,
      writeAudit: (ctx, entry) => writeAuditEntry(ctx, entry),
    },
  },
)

// convex/domain/<owner>/commands.ts
import { Command } from '../foundation'

const commands = new Command({
  'documents.rename': Command.operation({
    command: renameInput,
    result: renameResult,
    classification: 'business',
    audit: ({ command }, ctx) => ({ ... }),
  }),
})
export const executeRename = commands.exec({ operation: 'documents.rename', handler })
```

Every command is validated (input and output zod-parsed), observed, and
audited in-transaction. `classification` and `audit()` are mandatory per
operation: auditing is type-enforced, not opt-in. The foundation component
itself owns zero tables and ships `executeResultBoundary` (typed failures
only while the transaction has no effects; otherwise rethrow so Convex
rolls back).

### `cvx-kit/components/approvals` (component)

Declarative approval workflows (decision / branch / mutation / action /
notify) with quorum, maker-checker, expiry, compatibility keys, durable
execution via a nested `@convex-dev/workflow`, and its own audit trail via a
nested `convex-audit-log`. Tenancy is an opaque `scopeRef`; callbacks are
function handles — the component never imports host code.

```ts
// convex/convex.config.ts
import approvals from 'cvx-kit/components/approvals'
app.use(approvals)
```

## Component authoring conventions

This package follows the official Convex component template
(`get-convex/templates/template-component`; see
https://docs.convex.dev/components/authoring):

- Components live in `src/components/<name>` with their own
  `convex.config.ts`, `schema.ts`, functions, and **checked-in
  `_generated/`** (required for npm-distributed components).
- Hosts mount via the `./components/<name>/convex.config` subpath export and call the
  component only through its client class — never its tables directly.
- `bun run build:codegen` re-runs `convex codegen --component-dir` for both
  components before building.
- Consumers test in-memory via the `cvx-kit/test` export:

```ts
import { convexTest } from 'convex-test'
import { registerApprovals, registerFoundation } from 'cvx-kit/test'

const t = convexTest(appSchema, modules)
registerFoundation(t)
registerApprovals(t)
```

## Releasing

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
(OIDC) — no tokens stored anywhere. The release workflow authenticates via
GitHub's OIDC and npm generates provenance attestations automatically.

- `bun run release` — patch version bump, tag, and push; the `v*` tag
  triggers `.github/workflows/release.yml`, which verifies (typecheck, test,
  build + publint) and publishes.
- `bun run release:minor` — same, minor bump.

One-time setup (already-published package required first):

1. First publish is manual: `npm publish --access public` locally.
2. On npmjs.com → package → Settings → Trusted Publisher: GitHub Actions,
   owner `ImRLopezAG`, repository `cvx-kit`, workflow `release.yml`,
   environment `npm`.
3. Create the `npm` environment in the GitHub repo settings.

## Roadmap

- [ ] Port the approvals `copyability` test (cp -r + tsc + `convex codegen
      --dry-run`) into this repo's suite as the portability guarantee.
- [ ] `createArchitectureTest(rules)` helper so consuming projects get the
      boundary guardrails (no inline tables/enums, single facade per
      component) on day one.
- [ ] WorkOS scaffold generator for `auth.ts` / `auth.config.ts` / `http.ts`.
- [ ] Audit facade helpers (fingerprinted cursors, bounded windows) over any
      `convex-audit-log` instance.
- [ ] Decide the published name/scope before `npm publish` (`cvx-kit` is a
      working title).
