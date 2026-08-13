# Migrating an existing Convex project to the cvx-kit architecture

This guide takes a "raw" Convex project — the typical shape where every file at
the root of `convex/` exports public queries and mutations, tables are defined
inline in `schema.ts`, and validators are `v.*` objects repeated per function —
and restructures it into the cvx-kit architecture.

This is an **opinionated infrastructure**. The rules below are not
suggestions; they are the contract. Where the kit makes something structural
(auth, triggers, bounded reads, mandatory audit), the migration's job is to
remove every code path that circumvents the structure. Names in `<angle
brackets>` are placeholders for your own vocabulary — no specific entity,
table, field, or workflow is mandated, only the roles and rules.

Migrate incrementally: each step leaves the app deployable, and old and new
shapes can coexist while you move entity by entity.

---

## 1. The target structure — complete

```
convex/
  convex.config.ts            # component mounting. Nothing else.
  schema.ts                   # defineSchema(domainTables). Nothing else.
  functions.ts                # the single createAuthFunctions(...) call
  triggers.ts                 # the single trigger registry + helper registrations
  foundation.ts               # the single new Foundation(...) facade
  <component>.ts              # one facade per mounted component (audit.ts, approvals.ts, pool.ts, workflows.ts, ...)
  auth.ts                     # identity-provider client wiring
  auth.config.ts              # Convex auth providers config
  http.ts                     # HTTP router (webhook endpoints delegate to domains)
  crons.ts                    # cron declarations only; targets are internal domain functions

  api/                        # ═══ THE ONLY PUBLIC SURFACE ═══
    <entity>.ts               # thin adapters: auth* constructors → domain executors → DTOs

  domain/                     # ═══ ALL BUSINESS LOGIC ═══
    table.ts                  # merges per-entity table maps into domainTables
    shared/                   # genuinely cross-entity code ONLY
      schema.ts               #   cross-entity zod helpers (if any)
      <provider>.ts           #   one configured vendor client per provider (sql, cache, email, ...)
    <entity>/                 # one directory per entity/aggregate
      schema.ts               #   the zodTable declaration — shapes and masks, nothing else
      table.ts                #   index topology attached to <zodTable>.table
      constants.ts            #   finite vocabularies: UPPER_SNAKE readonly tuples
      commands.ts             #   operation registry + command executors
      queries.ts              #   domain read logic
      rules.ts                #   pure domain invariants/predicates (no ctx, no db)
      shared.ts               #   helpers shared by multiple files of THIS entity
      <workflow>.ts           #   approval/workflow definitions this entity owns
      <workflow>_functions.ts #   internal callback targets (system* constructors)
      actions.ts              #   external-side-effect logic (via shared provider clients)
      __tests__/              #   behavioral tests for this entity

  components/                 # only if the app authors its own portable components
    <name>/                   # own convex.config.ts, schema.ts, _generated/, __tests__/

  __tests__/                  # ═══ APP-WIDE GUARDRAILS ═══
    setup.ts                  # env stubs for vars declared on defineApp({ env })
    architecture.test.ts      # the executable conventions (see §6)
    facades.test.ts           # each app.use exactly once; no private-child access
```

### The root rule

**The root of `convex/` contains configuration and facades only.** Every root
file is a *declaration point* — the single place one piece of infrastructure
is configured — and none of them exports a public function or contains
business logic. If a client can call it, it lives in `api/`. If it decides
anything about the business, it lives in `domain/`. If `ls convex/*.ts` shows
anything else, the migration is not done.

### Hard prohibitions (grep-able, test-enforceable)

These patterns must not exist anywhere after migration — each one is a hole in
a structural guarantee:

| Forbidden | Where it's allowed instead | What it breaks otherwise |
|---|---|---|
| `query(`, `mutation(`, `action(`, `internalMutation(`, `internalAction(` from `_generated/server` | `functions.ts` only | auth, triggers, bounded reads |
| `defineTable(` | `domain/<entity>/table.ts` via `<zodTable>.table` | single source of truth per entity |
| `defineSchema(` | root `schema.ts` only | schema assembly |
| inline `z.enum([...])` / repeated literal unions | tuple in `constants.ts` | vocabulary ownership |
| `.collect()` / unbounded reads in public paths | `ctx.include(...).execute(limit)` | read bounds |
| `makeFunctionReference` | generated `internal` / `api` | refactoring safety |
| deep imports of a component's internals | the component's client facade | component boundary |
| sibling-domain imports (`domain/a` → `domain/b`) | `domain/shared/` or the public API | ownership |
| `ctx.db.insert/patch/delete` on a mounted component's tables | the component's client methods | component persistence |
| vendor SDK instantiation inside a domain | one shared client in `domain/shared/<provider>.ts` | connection discipline |
| `new Date().toISOString()` / hand-written timestamp fields | the `timestamps` trigger | server-owned lifecycle |

---

## 2. Where each kind of existing code goes

A raw project's root files usually mix several kinds of code. Pull them apart:

| You have today | It becomes |
|---|---|
| `export const get/list = query({...})` at root | adapter in `api/<entity>.ts` + read logic in `domain/<entity>/queries.ts` |
| `export const create/update = mutation({...})` at root | adapter in `api/<entity>.ts` + operation in `domain/<entity>/commands.ts` |
| `internalMutation`/`internalAction` helpers | `system*` functions in `domain/<entity>/<purpose>_functions.ts` |
| inline `defineTable({...})` in `schema.ts` | `zodTable` in `domain/<entity>/schema.ts` + indexes in `domain/<entity>/table.ts` |
| `v.union(v.literal(...))` / inline `z.enum` repeated around | one `UPPER_SNAKE` tuple in `domain/<entity>/constants.ts` |
| validation/business `if`-chains inside handlers | pure predicates in `domain/<entity>/rules.ts` |
| shared grab-bag (`helpers.ts`, `utils.ts`, `lib.ts`) | split by owner into `domain/<entity>/shared.ts`; only genuinely cross-entity code into `domain/shared/` |
| ad-hoc vendor clients (HTTP SDKs, caches, SQL) | one configured client per provider in `domain/shared/<provider>.ts` |
| webhook handlers with logic in `http.ts` | route in `http.ts`, logic in `domain/<entity>/actions.ts` |
| cron handlers with logic in `crons.ts` | declaration in `crons.ts`, target `system*` function in the domain |
| audit/log/history tables mirroring component state | the component's own persistence via its facade |

---

## 3. Naming — the full convention set

Naming is part of the architecture: several kit mechanisms key off it at
runtime (observability drops non-conforming events), and the rest makes the
codebase greppable.

- **Directories**: `domain/<entity>/` uses the plural camelCase table name.
  One entity, one directory — no `domain/misc/`.
- **Tables**: plural camelCase (`<entities>`).
- **Indexes**: `by_<field>` / `by_<field>_and_<field>`, fields in declaration
  order, nested paths flattened with `_` (`by_ownerId_and_state_status` for
  `['ownerId', 'state.status']`). A reader must be able to reconstruct the
  index definition from its name.
- **Command operations**: `<entity>.<verb>` lowercase dotted
  (`invoices.approve`). Must match `/^[A-Za-z][A-Za-z0-9_.-]{0,159}$/` or
  observability drops the events.
- **Error codes**: `UPPER_SNAKE`, matching `/^[A-Z][A-Z0-9_]{0,95}$/`. Define
  the full set once (one owner), not per callsite.
- **Vocabulary tuples**: `UPPER_SNAKE_CASE` exported `as const`; derived type
  `PascalCase` singular (`const <ENTITY>_STATES = [...] as const;
  type <Entity>State = (typeof <ENTITY>_STATES)[number]`).
- **Domain executors**: `execute<Verb><Entity>` (`executeApproveInvoice`) —
  the grep-able seam between adapters and domain.
- **Internal callback files**: `<purpose>_functions.ts` next to the
  `<purpose>.ts` that references them.
- **Public function names** are `api/<entity>:fn` — clients never reference a
  root-level path.

---

## 4. Step-by-step migration

### Step 0 — Inventory

List every exported function and classify it: public read, public write,
internal, cron target, HTTP handler. List every table, every index, every
literal string union, every vendor client instantiation. This is the
checklist; entities with the fewest dependencies migrate first.

### Step 1 — Mount the kit, declare the root files

Install `cvx-kit`, mount `foundation` (and `approvals` if needed) in
`convex.config.ts`, run codegen. Create `functions.ts`, `triggers.ts`,
`foundation.ts`, and one facade per mounted component. Declare required env
vars on `defineApp({ env: { ... } })` so deploys fail fast, and stub them in
`__tests__/setup.ts`. Nothing breaks: raw functions keep working alongside
the new constructors.

### Step 2 — Convert tables entity by entity

For each table:

1. `domain/<entity>/schema.ts`: a `zodTable` mirroring the current shape,
   `v.*` converted to zod. Decide the three masks **deliberately** —
   `serverFields` (server-assigned), `commandFields` (what a write request
   may say), `publicFields` (what a client may see). This is where implicit
   trust becomes explicit policy; a mis-declared mask is a security bug, so
   review masks like auth code.
2. `domain/<entity>/table.ts`: move the indexes, renamed to the convention.
3. Register in `domain/table.ts`; shrink root `schema.ts` toward
   `defineSchema(domainTables)`.
4. The kit's timestamps are `.optional()`, so existing rows validate without
   backfill. Register `timestamps(triggers, '<table>')`; new writes maintain
   `createdAt`/`updatedAt`. Backfill later if needed. Existing hand-rolled
   timestamp fields (e.g. ISO strings) stay in the shape for now — migrate
   the data separately; never couple data migration to restructuring.
5. Apply write discipline per table while you're here: `appendOnly` for
   evidence tables (votes, history), `noDelete` + `archivedAt` for anything a
   human might ask about later. Hard deletes are opt-in per table, not the
   default.

### Step 3 — Move vocabularies to `constants.ts`

Every reusable finite vocabulary gets one owner: an exported tuple in the
owning entity's `constants.ts`. Schemas, validators, filters, transition
maps, and tests consume the tuple. Subsets and ordered presentations derive
from the canonical tuple, typed against its value type so an invalid literal
cannot compile. A file-local tuple is acceptable **only** for private
implementation mechanics that can never appear in another schema, contract,
persisted document, or UI state — and it is still `UPPER_SNAKE_CASE`.

### Step 4 — Split public functions into adapter + domain logic

For each public function at the root:

1. **Extract the domain logic.** Reads → `domain/<entity>/queries.ts`.
   Writes → an operation in the entity's command registry with
   classification and audit derivation (see `commands.md`) — deciding *what
   gets audited and as what* is a product decision; make it explicitly, not
   as an afterthought. Pure conditions the handler checks
   (state-transition legality, permission-beyond-role predicates) →
   `rules.ts`, so they're unit-testable without a ctx.
2. **Write the adapter** in `api/<entity>.ts` with `authQuery`/
   `authMutation`/`role*`/`admin*`. Adapters do exactly four things: parse
   args with the entity's boundary schemas, authorize via the constructor
   choice, call the domain executor with `ctx.actor`, project through
   `toPublicDto`. **Adapter budget: if it exceeds ~10 lines of glue or grows
   a private helper, logic is leaking — move it into the domain.**
3. **Retire the old path.** Public names change to `api/<entity>:fn`; update
   client call sites per entity, or keep a temporary re-export file at the
   old path and delete it in the final step.

Anything "public-but-really-internal" (only called by your own scheduled
functions or other backend code) must stop being public: convert to `system*`
in the domain.

### Step 5 — Convert internal functions and the wiring files

- Replace raw `internalMutation`/`internalAction` with `systemMutation`/
  `systemAction` from `functions.ts`, located in the owning domain's
  `<purpose>_functions.ts`. Scheduled and callback writes now run under the
  same trigger regime as user writes.
- `crons.ts` becomes declarations only, targeting `internal.domain.<entity>.
  <purpose>_functions.*`.
- `http.ts` becomes routing only: verify the webhook signature, parse the
  payload at the boundary, delegate to a domain action/function.

### Step 6 — Bound the reads

Replace `.collect()` and unbounded `.take(n)` in public paths with
`ctx.include(...).execute(limit)` (limit ≤ 100). Where a query can't be
served by an index, **add the index** — a scan is a schema problem, not a
query-code problem. Paginated surfaces cross the boundary with the convex
pagination validators bridged into zod (`convexToZod(paginationOptsValidator)`
and a `paginationResultValidator` built from the row validator), not with
hand-rolled cursor objects.

### Step 7 — Enforce everything with tests

Port the executable-architecture pattern. `__tests__/architecture.test.ts`
globs all production sources and asserts the Hard Prohibitions table above;
**each rule is proved against a synthetic violating fixture first** so a
broken checker cannot silently pass. `facades.test.ts` asserts each
`app.use(x)` appears exactly once and no file reaches a component's private
children. From this point the migration cannot regress — and neither can
future contributors or coding agents.

---

## 5. File conduct — how every source file is organized

From the origin project's code conduct. Apply to new code and files being
substantially changed; don't mechanically rewrite untouched files.

**File order** — readable from public purpose to private implementation:

1. Imports.
2. Exported types, schemas, constants, and public functions — the API.
3. File-local types and constants supporting the implementation.
4. Private helpers, as **named function declarations**, at the bottom.

```ts
import { parseInput } from './schema'

export async function createProjection(input: unknown) {
  return buildProjection(parseInput(input))
}

function buildProjection(input: ProjectionInput) {
  // implementation
}
```

Never place private helper implementations above the exported API. Prefer
`function` declarations over helper arrow-constants so helpers can live at
the bottom.

**Ownership.** Put behavior beside the entity that owns it. Consumers (api
adapters, cron targets, workflow callbacks) stay thin: validate, authorize,
call the owning operation, translate the result. A consumer accumulating
entity rules or a pile of private helpers is logic asking to move into the
domain.

**No convenience re-exports.** Import a function from the file that owns it;
never re-export to shorten a path. Barrel files (`index.ts` re-exporting a
directory) are banned inside `convex/` — they blur ownership and create
import cycles.

**Components own their persistence.** Never mirror a mounted component's
internal state (audit events, workflow steps, job results) into application
tables unless the product domain independently requires a durable business
record. Log through the facade; don't build a receipts table for it.

**Comments state constraints, not narration.** The accepted pattern for
schema evolution is a one-line epoch comment on an `.optional()` field
explaining why it's optional. Comments that restate the next line are noise.

---

## 6. Documentation the migrated repo must carry

An opinionated codebase documents its opinions, or they die at the first
new contributor. Minimum set:

- **`CODE_CONDUCT.md`** (or equivalent) — the repo's own conventions: file
  order, ownership layout, vocabulary rules, naming. This guide's §3 and §5
  are the starting template; adapt, don't link.
- **`CONCEPTS.md`** — the domain glossary: every entity, state, and
  vocabulary word with its business meaning. LLMs and new hires read this
  first; keep entries one paragraph.
- **`CLAUDE.md` / `AGENTS.md`** — thin pointers: the stack, the three
  commands that matter (test, typecheck, deploy), and links to
  `CODE_CONDUCT.md` + `node_modules/cvx-kit/src/docs/llms.md`. Agent files
  that duplicate the conduct doc drift; keep them as an index.
- **Architecture tests as documentation** — the test names in
  `architecture.test.ts` are the enforceable summary of the conduct doc;
  a rule that exists in prose but not in the suite is a request, not a rule.

---

## 7. Definition of done

The migration is complete when every box checks:

- [ ] `ls convex/*.ts` shows only configuration and facades (§1 table).
- [ ] Every public function lives in `api/` and uses `auth*`/`role*`/`admin*`.
- [ ] Every internal function uses `system*` and lives in its domain.
- [ ] `functions.ts` is the only file importing `_generated/server` builders.
- [ ] Every table is a `zodTable` with deliberately reviewed masks; indexes
      named by convention; timestamps trigger registered.
- [ ] Every vocabulary is a single-owner tuple in a `constants.ts`.
- [ ] Every state change is a command operation with classification + audit.
- [ ] Every public read is bounded (`include` + limit, or bridged pagination).
- [ ] No entry in the Hard Prohibitions table greps positive.
- [ ] `architecture.test.ts` + `facades.test.ts` exist, each rule fixture-proved.
- [ ] `CODE_CONDUCT.md` and `CONCEPTS.md` exist; agent files point at them.
- [ ] Transitional re-exports deleted; clients call `api/<entity>:fn` paths.

## Migration order that works

1. Root files + kit mounting (step 1) — zero behavioral change.
2. The smallest, least-referenced entity end-to-end (steps 2–6) — shakes out
   masks, role mapping, and conventions on a low-stakes surface.
3. Architecture tests (step 7) — lock the rules in **before** the bulk.
4. Remaining entities in dependency order, one PR each.
5. Delete transitional re-exports and remaining root function files; run the
   definition-of-done checklist.
