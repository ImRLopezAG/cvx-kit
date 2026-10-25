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

Supported versions: Convex `^1.46.0`, Zod `^4.5.4`, Bun `1.3+`, and Node.js
`24+` with npm `11+`. The library runtime is ESM-only.

## Toolchain

- `bun install` — dependencies
- `bun run test` — vite-plus test suite (`vp test run`, convex-test on edge-runtime)
- `bun run typecheck` — `tsc --noEmit`
- `bun run build` — `vp pack` (tsdown on Rolldown); all build options live in
  the `pack` key of `vite.config.ts`: per-module ESM + `.d.mts` to `dist/`,
  target ES2025, minified, deps external, publint-verified
- `bun run build:codegen` — re-run `convex codegen` for both components, then build

## Documentation

Full docs live on [GitHub](https://github.com/ImRLopezAG/cvx-kit/tree/main/skills/cvx-kit/references)
and are bundled with the repository's [agent skill](https://github.com/ImRLopezAG/cvx-kit/tree/main/skills/cvx-kit).
The npm package includes this README; full docs and skills are installed separately.

If you use a coding agent, install the cvx-kit skill from your application directory:

```sh
npx skills add ImRLopezAG/cvx-kit --skill cvx-kit
```

The [skills CLI](https://www.skills.sh/docs) lets you choose your agent. Installation
is project-scoped by default; add `--global` only for a user-wide install. Public
GitHub installation needs no login. Preview available skills with
`npx skills add ImRLopezAG/cvx-kit --list`.
The skill reads the guides needed for each task instead of loading all docs.
Check your installed package version against the skill's source revision before
using newer APIs. For a release containing the skill, use its GitHub tag URL
(`https://github.com/ImRLopezAG/cvx-kit/tree/<tag>/skills/cvx-kit`) as the install source.

Maintainers edit `skills/cvx-kit/references/` directly. CI verifies that relative
links remain inside the installed skill with `bun run skills:check`.

Guides:

- [`native-id-relations.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/native-id-relations.md) — native-ID union links, authorized inverse pages, and migration

- [`architecture.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/architecture.md) — the layered application shape the kit encodes
- [`conventions.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/conventions.md) — the doctrine: folder structure, file anatomy, naming grammar, import rules
- [`zod-table.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/zod-table.md) — one zod shape per entity, masked into every boundary
- [`auth.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/auth.md) — auth-aware function constructors from injected policy
- [`commands.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/commands.md) — Effect command declarations, lifecycle, and migration
- [`effect.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/effect.md) — opt-in Effect v4 registries, injected services, and shared API builders
- [`domain-operations.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/domain-operations.md) — server domain/API examples, contracts, errors, receipts, workflow steps, and selected tools
- [`triggers.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/triggers.md) — trigger registry, timestamps/append-only/no-delete
- [`approvals.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/approvals.md) — declarative approval workflows
- [`tenancy.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/tenancy.md) — row-level security (roles) with opt-in multi-tenant isolation
- [`crud.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/crud.md) — the CRUD command factory
- [`webhooks.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/webhooks.md) — the sanctioned webhook boundary
- [`agent-tools.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/agent-tools.md) — agent tools that are audited commands
- [`upgrading.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/upgrading.md) — 0.0.x → 0.1.0, old way → new way
- [`maintainability.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/maintainability.md) — keeping a Convex app maintainable long-term
- [`migration.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/migration.md) — restructuring an existing raw Convex project into this architecture
- [`llms.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/llms.md) — optional condensed reference for coding agents

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
		commandFields: ['title'], // what a command may say
		publicFields: ['title', 'ownerId'], // the DTO allowlist
	},
)
// documents.table → defineTable(...) for schema.ts
// documents.toPublicDto(row) → projects AND re-parses (runtime redaction)
```

For fields shared across tables, create a reusable declaration function:

```ts
import { createTable } from 'cvx-kit/zod-table'

const customTable = createTable({ ref: z.string(), nextActivity: z.string() })
const tasks = customTable('tasks', () => ({ title: z.string() }))
const projects = customTable('projects', () => ({ name: z.string() }))
```

It accepts the same arguments and returns the same boundary as `zodTable`.
Table-specific fields cannot repeat shared field names. See the
[`zod-table` guide](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/zod-table.md)
for field masks and examples.

Every table gets `createdAt`, `updatedAt`, and `archivedAt` baked in —
opinionated, server-owned, always excluded from inserts and commands
(expose them via `publicFields` when a DTO needs them). Register the
`timestamps` trigger once and they maintain themselves; `archivedAt` stays
under application control.

`zodVariantTable` covers discriminated-union tables; `jsonSafeZid` keeps
LLM-tool JSON schemas primitive while preserving the `Id<...>` type.

### `cvx-kit/relations` and `cvx-kit/querying`

See the [querying guide](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/querying.md),
[DTO parameters](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/zod-table.md#public-dto-parameters), and
[consumer rule reference](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/oxlint.md#dto-and-pagination-diagnostics).

Declare relationships once in `convex/relations.ts`, then configure the engine
once in `convex/querying.ts`. Both factories are also available from the package
root. The relations subpath exposes declarations and public types; executor
metadata and managed reader capabilities are internal.

```ts
// convex/relations.ts
import { defineRelations } from 'cvx-kit/relations'
import './domain/tasks/table' // Establish native indexes before compiling the registry.
import { tasks, labels, edges } from './domain/tasks/schema'

export const relations = defineRelations({ tasks, labels, edges }, (r) => ({
	tasks: {
		referenceTask: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }),
		labels: r.many.labels({
			from: r.tasks._id.through(r.edges.task),
			to: r.labels._id.through(r.edges.label),
		}),
	},
}))
```

The tables can be `zodTable`, `tenantTable`, or three-argument `zodVariantTable` boundaries, with
indexes supporting each declared lookup. Names can distinguish multiple edges
to the same table; references can point to the same table. A one edge returns a
public DTO or `null`. A many edge returns a bounded native page. Junction output
preserves duplicate edge occurrences, even when target reads are memoized.
Missing and unreadable targets have the same public result.

`defineRelations` captures table names, stored field semantics, public DTO
validation, variants, active indexes, and relation declarations. Complete schema
and index configuration before calling it. Later changes to source declarations
do not affect existing registries, helpers or engines. Create a new registry to
adopt changes. Caller-owned declarations remain mutable.

Relation DTOs support `.refine()`. They reject opaque `.superRefine()` and
`.check()` callbacks; express those validations with `.refine()` instead.
Captured callbacks still observe application state through their closures.

Variant tables keep their discriminated public unions. Use the relation callback's
second argument, `branch('payments', 'creditor_payment').creditorId`, for a
branch-specific reference; its tag is checked before lookup. See the
[variant querying guide](skills/cvx-kit/references/variant-querying.md) for the
complete authenticated flow and branch filter syntax.

```ts
// convex/querying.ts
import { createQueryEngine } from 'cvx-kit/querying'
import schema from './schema'
import { relations } from './relations'

export const querying = createQueryEngine({ schema, relations })
```

One engine serves every registered table. Cursor keys load internally on first
pagination from server environment variables `CVX_QUERY_CURSOR_KEYS_JSON`
(key IDs mapped to 128-character hex secrets) and `CVX_QUERY_CURSOR_CURRENT_KEY_ID`.
Keep key material out of arguments, client code, and logs. Optional overrides
belong in a separate second argument; see [querying](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/querying.md). The default codec
uses authenticated AES-SIV encryption without a plaintext fallback; identical
payloads under the same binding reveal equality. Tokens bind filters, selected
output, index, order, relation ancestry, principal/tenant/security scope, and
registry/policy/engine versions. Page-size changes alone remain valid. Retain
old keys during rotation when existing cursors should continue working.

Use the registry's validators in domain contracts and an authenticated Query
registry handler:

```ts
const options = relations.tables.tasks.paginationOpts({
	department: true,
	status: true,
	labels: { name: true },
})
const result = relations.tables.tasks.pageDto({ labels: true })

// In the Query operation's handler, ctx comes from createAuthFunctions.authQuery.
const page = await querying(ctx)
	.tasks.where({ tenant: ctx.tenant })
	.with({ labels: true })
	.paginate(args)

// A separate authenticated child endpoint validates parent with tasks.schema.shape._id.
const nextLabels = await querying(ctx)
	.tasks.relation(parent, 'labels')
	.paginate({ numItems: 25, cursor: page.page[0].labels.continueCursor })
```

Select filterable stored fields explicitly, including server-owned fields when
needed. Public DTO fields do not determine filter eligibility. Scalar predicates
support equality, ranges, `and`, `or`, and `not`; many predicates use `some` or
`none`. Eligibility and composed read authorization run before parents fill a
page. Parent, junction, target, and continuation reads all recheck authorization.
`include` and `paginated(dto)` retain their existing behavior independently.

Chain `.when(value, 'index_name')` to choose the first present condition: `false`,
`0`, and `''` are present; `null` and `undefined` are absent. The gate does not
bind an index field; validated filters and server `.where(...)` constraints do.
An incompatible explicit choice fails. Automatic selection uses the longest
usable equality prefix, then stable index-name order, with creation-time fallback.
`order: 'desc'` reverses the chosen native index order. Native continuation,
split/end cursors, and page status are preserved, with external tokens protected.

Browse page sizes are positive integers up to 100; central `maxPageSize` may lower that
ceiling. Central budgets bound read operations, index ranges, raw candidates,
observed/reserved document bytes, fan-out, depth, and memo entries across a
request, including policy reads. Native request read limits may lower ceilings.
An incomplete eligibility proof throws `MANAGED_READ_BUDGET`; it is never an
empty exhausted page or a negative predicate. Output relationship depth is at
most four. Traversal executes in the caller's query transaction and may require
many reads. Application/helper accounting does not measure physical platform I/O.

Kit auth query contexts carry the engine's private read capability. Unknown
contexts fail closed unless a centrally configured trusted adapter attests their
query reader, effective policy, and security scope. Mutation/action contexts,
vector search, arbitrary predicates/projections,
and custom sorts are outside this API.

Root full-text search uses a declared native search index and keeps native relevance order:

```ts
const page = await querying(ctx).tasks
 .search('search_text', input.text)
 .where({ status: 'open' })
 .include({ finance: 'if-permitted' })
 .with({ labels: true })
 .paginate({ numItems: 25, cursor: input.cursor, scanLimit: 250 })
```

Declare `search_text` on the exact native table registered in `relations`.
Search supports the existing root filters, field groups and nested output;
direct `.relation(...).search(...)` is unsupported. Nested relationship pages
remain ordinary browse pages. Root search returns `paginationMode: 'native-search'`,
null split metadata, and no caller-pinned `endCursor`, custom order or refill.
A short or denied-empty page can still have `isDone: false`: continue manually
with its `continueCursor` (or `usePaginatedList().fetchNextPage()`).

Search `numItems` requests a positive integer initial native target, clamped by
central limits and the remaining branch threshold. Live windows can return more raw rows.
`scanLimit` is a cursor-branch admission threshold: all raw candidates, including
denied rows, count in authenticated `seen` state. A whole window can overshoot
(e.g. seen 6 + 5 rows with limit 9 returns all authorized rows, then stops with
`result-cap`). Replaying a cursor repeats that branch; this is no global quota.
Root search payload accounting is separate from shared policy/relationship read,
byte, depth and fan-out budgets. Any unfinished nested read, policy exception or
DTO failure aborts the whole page and mints no new continuation.

Project errors explicitly at registered endpoint boundaries: ordinary `authQuery`
handlers catch and throw `new ConvexError(queryFailureContract.project(error))`
from `cvx-kit/querying`. Effect constructors configure
`query: { errors: queryFailureContract }` and wrap the promise in
`Effect.tryPromise({ try: () => /* search page */, catch: error => error })`.
The declared contract sanitizes unknown failures; do not transport raw exceptions.
See the [search contract](skills/cvx-kit/references/querying.md#root-full-text-search)
and [React list protocol](skills/cvx-kit/references/client-list.md).

For manual projection, `tasks.toPublicDto(row)` still omits IDs and unselected
storage fields. `tasks.toPublicDto(row, true)` or `{ _id: true }` adds the branded
ID only. Computed extensions use matching schemas:

```ts
const extend = { url: z.url() }
const dto = tasks.toPublicDto(row, {
	_id: true,
	extend,
	values: { url: `https://example.test/tasks/${row._id}` },
})
const returnSchema = tasks.dto({ _id: true, extend })
```

To migrate, replace manual ID spreads with the shorthand and copied pagination
objects with `paginationOpts`. Move eligibility filters before bounded reads by
expressing them in the engine. Replace recognized unbounded relationship
collections with declared many pages and authenticated continuation endpoints.
Consumer diagnostics identify these patterns when kit/native provenance is known;
predicate movement has no automatic fix. Keep declarations in root
`relations.ts`/`querying.ts` and contracts and Query registries in their domain.

The [packed executable example](./test/fixture-packed-querying/convex/) includes
domain tables, contracts, authenticated API adapters, one/self/named/many/junction
edges, and child continuation. Its `.template` files become ordinary TypeScript
in isolated consumers; `bun run test:package:querying` installs the tarball on
installed and minimum peers, checks strict declarations and consumer rules, and
runs the full independent stress oracle and focused tie, output, replay, and
authorization-revocation probes. For a bounded anonymous local native proof,
run `node scripts/smoke-packed-querying.mjs <retained-packed-proof-directory>`
after the package check. It uses the same tarball and central default budgets.
Package publishing and application
migration remain separate work.

### `cvx-kit/auth`

`createAuthFunctions` builds the six auth-aware constructors from injected
policy — nothing in the kit imports your app's singletons:

```ts
import { createAuthFunctions } from 'cvx-kit/auth'
import { action, internalAction, internalMutation, mutation, query } from './_generated/server'

export const {
	authQuery,
	authMutation,
	authAction,
	adminQuery,
	adminMutation,
	adminAction,
	systemMutation,
	systemAction,
	include,
} = createAuthFunctions<DataModel>({
	query,
	mutation,
	action,
	internalMutation,
	internalAction,
	getAuthUser: (ctx) => authKit.getAuthUser(ctx),
	verifyMembership: async ({ userId, organizationId }) => {
		const memberships = await authKit.workos.userManagement.listOrganizationMemberships({
			organizationId,
			userId,
			statuses: ['active'],
		})
		const m = memberships.data.find((c) => c.userId === userId)
		return m ? { organizationId: m.organizationId, roleSlug: m.role.slug } : null
	},
	// resolveOrganization: async ({ ctx, user }) => { /* org+role from app tables */ },
	wrapDB: (ctx) => triggers.wrapDB(ctx),
})
```

Actions re-verify membership live and fail closed; mutations get the trigger
registry structurally; `include()` bounds every read (default 100 rows).
`resolveOrganization` derives org and role from your own tables, enabling
identity providers whose tokens carry no org claims.

### `cvx-kit/effect` — commands and queries

Use the Effect API for new commands. Install Effect `>=4.0.1 <5`, bind host
policies once with `createEffectFoundation`, and declare each handler inside
`command({...})` beside its schemas and audit policy.

<!-- packed-effect-example -->

```ts
import { createEffectFoundation } from 'cvx-kit/effect'
import type { AuditEntryInput } from 'cvx-kit/components/foundation'
import { z } from 'zod'

type Host = {
	actorId: string
	rename: (id: string, title: string) => Promise<void>
	appendAudit: (entry: AuditEntryInput) => Promise<void>
}
const { Command } = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'RENAME_FAILED' }),
	},
	writeAudit: (host: Host, entry) => host.appendAudit(entry),
})
const renameInput = z.object({ id: z.string(), title: z.string() }).strict()
export const commands = Command({
	context: (host: Host) => host,
	operations: ({ command }) => ({
		'documents.rename': command({
			input: renameInput,
			result: z.object({ ok: z.literal(true) }).strict(),
			classification: 'business',
			handler: async (input, context) => {
				await context.rename(input.id, input.title)
				return { ok: true as const }
			},
			audit: ({ command }, context) => ({
				operation: 'documents.rename',
				actorId: context.actorId,
				aggregate: { type: 'document', id: command.id },
			}),
		}),
	}),
})
export const executeRename = (input: z.input<typeof renameInput>, host: Host) =>
	commands.exec('documents.rename', input, host)
```

`exec` returns a lazy Effect even for ordinary async handlers. Shared
`effectApiBuilder` / `effectZodApiBuilder` constructors provide invocation-local
services and execute it; domain code can compose `Effect.gen` and `Effect.fn`
without starting another runner. Commands validate inputs and results, enforce
permissions and guards, and write audit entries in the mutation transaction.
See [commands](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/commands.md), [complete Effect wiring](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/effect.md),
and [authenticated builders](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/auth.md).

The old `Foundation.Command` Promise facade is **deprecated** and retained for
existing consumers. Its separate executor handler options are covered only in
the [compatibility reference](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/commands-legacy.md). The Foundation
component and its transaction result helpers remain available.

### `cvx-kit/components/approvals` (component)

Declarative approval workflows (decision / branch / mutation / action /
notify) with quorum, maker-checker, expiry, compatibility keys, durable
execution via a nested `@convex-dev/workflow`, and its own audit trail via a
nested `convex-audit-log`. Tenancy is an opaque `scopeRef`; callbacks are
function handles — the component never imports host code.

```ts
// convex/convex.config.ts
import approvals from 'cvx-kit/components/approvals/convex.config'
app.use(approvals)
```

## Application lint rules

The TypeScript plugin `cvx-kit/oxlint` checks applications using the kit against
[`conventions.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/conventions.md). It targets `convex/`, including
public adapters, domain modules, root facades, and locally authored components.
Load it in your application's `.oxlintrc.json` and select rules:

```json
{
	"jsPlugins": [{ "name": "cvx", "specifier": "cvx-kit/oxlint" }],
	"rules": {
		"cvx/project-structure": "error",
		"cvx/root-wiring-only": "error",
		"cvx/application-orchestration": "error",
		"cvx/internal-function-ownership": "error",
		"cvx/domain-file-responsibilities": "error",
		"cvx/reserved-domain-file-anatomy": "error",
		"cvx/no-raw-builders": "error",
		"cvx/no-handwritten-references": "error",
		"cvx/domain-import-boundaries": "error",
		"cvx/public-functions-in-api": "error",
		"cvx/thin-api-adapters": "error",
		"cvx/root-facade-ownership": "error",
		"cvx/no-inline-enums": "error",
		"cvx/no-unbounded-reads": "error",
		"cvx/no-manual-timestamps": "error",
		"cvx/component-boundaries": "error",
		"cvx/no-component-env": "error",
		"cvx/schema-file-boundaries": "error",
		"cvx/no-internal-reexports": "error",
		"cvx/public-api-first": "error",
		"cvx/named-private-helpers": "error"
	}
}
```

With Vite+, put those fields under `lint` in `vite.config.ts`. Each rule accepts
`{ "convexDir": "path/to/convex" }` when your backend directory differs from
`convex/`. Generated files and tests are excluded from source-code rules. `project-structure`
inspects the whole backend for directory ownership, colocated runnable tests, and
module cycles. Run Oxlint on the whole backend, including `convex.config.ts`;
changed-file-only lint cannot guarantee a project scan. No application-owned
architecture test framework is required. The plugin also exports `checkArchitecture()`
for tools that need project diagnostics directly, named `rules`, and `RuleName`. Verified with
Oxlint 1.87.0 and Vite+ 1.1.0. See [rule coverage and limitations](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/oxlint.md)
and the [migration from the initial 0.1.4 plugin](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/upgrading.md).

Repository checks and the enforced library rules are documented in
[`tools/oxlint/README.md`](https://github.com/ImRLopezAG/cvx-kit/blob/main/tools/oxlint/README.md). Run `bun run lint` for
anti-slop and architecture checks, `bun run test:lint` to test the custom
rules, and `bun run check` for the full Vite+ lint and formatting check.

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

Every release also creates a GitHub Release whose notes are the matching
[CHANGELOG](https://github.com/ImRLopezAG/cvx-kit/blob/main/CHANGELOG.md) section (extracted by
`scripts/extract-changelog.mjs` in the release workflow).

### OIDC setup

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
(OIDC) — no tokens stored anywhere. The release workflow authenticates via
GitHub's OIDC and npm generates provenance attestations automatically.

Merge the version bump and changelog into `main`, then wait for successful CI
on that exact commit before pushing its `v<version>` tag. The tag triggers
`.github/workflows/release.yml`, which checks the main CI result, builds and
validates the package and skill documentation, and publishes to npm.

One-time setup (already-published package required first):

1. First publish is manual: `npm publish --access public` locally.
2. On npmjs.com → package → Settings → Trusted Publisher: GitHub Actions,
   owner `ImRLopezAG`, repository `cvx-kit`, workflow `release.yml`,
   environment `npm`.
3. Create the `npm` environment in the GitHub repo settings.

## Roadmap

See [ROADMAP.md](https://github.com/ImRLopezAG/cvx-kit/blob/main/ROADMAP.md) — milestones from 0.1.0 through 1.0.0.

Optional request context can be added through the existing Effect API adapter's
`context` callback. Bind selected registries with `commands.withContext(value)`
and consume `ctx.commands.exec(name, input)` through the application's existing
function helper names. Keep dependencies local to each feature; explicit execution
and input-only command handlers remain supported. See [optional context injection](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/command-context.md).
