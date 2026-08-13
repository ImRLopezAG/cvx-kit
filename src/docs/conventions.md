# cvx-kit conventions — folder structure, file anatomy, and naming

This is the kit's doctrine. Not a style suggestion: the structure below is
what the kit's structural guarantees (auth, triggers, bounded reads, audited
commands) assume, and what its recommended architecture tests enforce. Follow
it as written; deviate only with a documented reason and a matching change to
the tests.

Names in `<angle brackets>` are placeholders for your vocabulary. Everything
else — the folder roles, the file anatomy, the naming grammar — is fixed.

---

## 1. Folder structure

```
convex/
  convex.config.ts
  schema.ts
  functions.ts
  triggers.ts
  foundation.ts
  <component>.ts            (one per mounted component: audit.ts, approvals.ts, ...)
  auth.ts  auth.config.ts  http.ts  crons.ts
  api/
    <entity>.ts
  domain/
    table.ts
    shared/
      <provider>.ts
    <entity>/
      schema.ts  table.ts  constants.ts  commands.ts  queries.ts
      rules.ts  shared.ts  actions.ts
      <workflow>.ts  <workflow>_functions.ts
      __tests__/
  components/               (only if you author portable components)
    <name>/
  __tests__/
    setup.ts  architecture.test.ts  facades.test.ts
```

Three zones, three privileges:

- **Root** — configuration and facades. May import kit modules, generated
  code, and component clients. May NOT export public functions or contain
  business decisions.
- **`api/`** — the public surface. May import `functions.ts` constructors and
  its entity's domain modules. May NOT contain business logic, private
  helpers, or reads/writes beyond delegation.
- **`domain/`** — all business logic. May import `functions.ts`,
  `foundation.ts`, facades, `domain/shared/`, and its own entity directory.
  May NOT import `api/`, sibling entities, `_generated/server` builders, or
  component internals.

Dependency direction is one-way: `api → domain → shared → kit`. Anything
pointing the other way is a violation.

---

## 2. File anatomy — what each file contains, exactly

Every file has one job. The lists below are exhaustive: if content isn't
listed for a file, it doesn't belong there.

### Universal file order

Every source file reads from public purpose to private implementation:

1. Imports.
2. Exported API — types, schemas, constants, functions.
3. File-local types and constants supporting the implementation.
4. Private helpers as **named function declarations**, at the bottom.

No helper implementations above the exported API. No helper
arrow-function constants where a `function` declaration works. No barrel
files (`index.ts` re-exports) anywhere inside `convex/`. No re-exporting
another file's function to shorten an import.

### Root files

| File | Contains | Never contains |
|---|---|---|
| `convex.config.ts` | `defineApp()`, one `app.use(...)` per component, `defineApp({ env })` declarations, `export default app` | anything else |
| `schema.ts` | `defineSchema(domainTables)` | table definitions, validators |
| `functions.ts` | the single `createAuthFunctions<DataModel>()` call and its exported constructors | handlers, business policy beyond the injected config |
| `triggers.ts` | `createTriggers()`, `timestamps`/`appendOnly`/`noDelete` registrations, calls to per-entity `register<Entity>Triggers` | trigger *logic* for a specific entity (that lives in the entity) |
| `foundation.ts` | the single `new Foundation(...)`, destructured exports | command definitions |
| `<component>.ts` | `new <Client>(components.<name>)` + minimal admin plumbing | workflow/business definitions |
| `http.ts` | routes: verify signature → parse payload → delegate to a domain function | webhook business logic |
| `crons.ts` | `cronJobs()` declarations targeting `internal.domain.<entity>...` | handler logic |

### `api/<entity>.ts` — the adapter file

One file per entity exposed to clients. Each exported function follows one
template and stays within ~10 lines of glue:

```ts
export const <verb> = authMutation({
  args: <entity>.commandInput.extend({ /* ids, etc. */ }),
  returns: <resultSchema>,
  handler: (ctx, args) => execute<Verb><Entity>(ctx, { ...args, actorId: ctx.actor.userId }),
})

export const list = authQuery({
  args: { limit: z.number() },
  returns: z.array(<entity>.publicDto),
  handler: (ctx, { limit }) =>
    ctx.include(ctx.db.query('<entities>'))
      .matching('by_<field>', (ix) => ix.eq('<field>', ctx.actor.userId))
      .execute(limit, (rows) => rows.map(<entity>.toPublicDto)),
})
```

Adapters do four things — parse (boundary schemas), authorize (constructor
choice), delegate (`execute*` with `ctx.actor`), project (`toPublicDto`).
The moment an adapter needs a private helper or a business `if`, that code
moves to the domain.

### `domain/<entity>/schema.ts` — shapes only

- The entity's single `zodTable(...)` call, with `serverFields`,
  `commandFields`, `publicFields` decided deliberately.
- DTO compositions derived from the table's boundaries
  (`z.object({ ...<entity>.publicDto.shape, ... }).strict()`).
- Inferred types (`export type <Entity> = z.infer<typeof <entity>.schema>`).
- NO indexes, NO `defineTable`, NO enum literals (consume `constants.ts`).

### `domain/<entity>/table.ts` — topology only

```ts
export const <entity>Tables = {
  <entities>: <entity>.table
    .index('by_<field>', ['<field>'])
    .index('by_<field>_and_<field2>', ['<field>', '<field2>']),
}
```

Registered in `domain/table.ts`, which merges all entity maps into
`domainTables`. Shapes change with the data model; indexes change with query
patterns — that's why they are separate files.

### `domain/<entity>/constants.ts` — vocabularies

Every finite value set the entity owns, one owner per vocabulary:

```ts
export const <ENTITY>_STATES = ['<a>', '<b>', '<c>'] as const
export type <Entity>State = (typeof <ENTITY>_STATES)[number]
```

Schemas, validators, filters, transition maps, and tests consume the tuple.
Transition maps are typed against the value type so an invalid literal cannot
compile. Numeric limits and durations the entity owns also live here.

### `domain/<entity>/commands.ts` — every state change

1. The frozen operation registry: `Command.operation({ command, result,
   classification, audit })` per operation, keys `'<entity>.<verb>'`.
2. One `new Command<Ctx, typeof operations>(operations)`.
3. Exported executors: `export const execute<Verb><Entity> = commands.exec(...)`.
4. Private handler helpers at the bottom.

Audit derivation lives here, next to the operation it describes. No reads
that belong in `queries.ts`; no pure predicates that belong in `rules.ts`.

### `domain/<entity>/queries.ts` — domain reads

Read logic worth reusing beyond one adapter: multi-step lookups, DTO
assembly, cross-index selection. Bounded like everything else.

### `domain/<entity>/rules.ts` — pure invariants

Predicates and transition checks with **no ctx and no db**: unit-testable
business truth (`can<Verb>(doc, actor)`, `isTransitionLegal(from, to)`).
Handlers call rules; rules never call handlers.

### `domain/<entity>/shared.ts` — entity-private helpers

Code shared by two or more files *of this entity*. If a second entity needs
it, it moves to `domain/shared/` — never a sibling import.

### `domain/<entity>/actions.ts` — external side effects

Action-side logic using the shared provider clients from
`domain/shared/<provider>.ts`. Domains import the shared client; they never
instantiate their own vendor SDK.

### `domain/<entity>/<workflow>.ts` + `<workflow>_functions.ts`

The workflow/approval definition the entity owns, and its internal callback
targets built with `system*` constructors. Callbacks re-validate everything:
`normalizeId`, `resourceType` check, staleness guard.

### `domain/shared/` — cross-entity, and only cross-entity

One configured client per external provider (`<provider>.ts`), plus zod/util
helpers genuinely used by multiple entities. This directory is not a dumping
ground: code with one consumer moves back to that consumer.

### Tests

- `domain/<entity>/__tests__/` — behavioral tests for the entity, driven
  through the real constructors (`t.withIdentity(...)`).
- `convex/__tests__/architecture.test.ts` — the executable conventions;
  every rule proved against a synthetic violating fixture first.
- `convex/__tests__/facades.test.ts` — every `app.use` exactly once; no
  private-child access.
- `convex/__tests__/setup.ts` — env stubs for `defineApp({ env })` vars.
- Test files are named `<subject>.test.ts` and live in a `__tests__/`
  directory beside the code they test — never in a parallel top-level tree.

---

## 3. Naming grammar

| Thing | Convention | Example shape |
|---|---|---|
| Entity directory | plural camelCase, matches table name | `domain/<entities>/` |
| Table | plural camelCase | `<entities>` |
| Fields | camelCase; foreign keys `<other>Id`; timestamps only via the kit | `ownerId`, `archivedAt` |
| Index | `by_<field>` / `by_<field>_and_<field>`, declaration order, nested paths flattened with `_` | `by_ownerId_and_state_status` |
| Command operation | `<entity>.<verb>` lowercase dotted; must match `/^[A-Za-z][A-Za-z0-9_.-]{0,159}$/` | `<entities>.approve` |
| Error code | `UPPER_SNAKE`, matching `/^[A-Z][A-Z0-9_]{0,95}$/`, defined in one owner | `INVALID_REQUEST_BOUNDARY` |
| Vocabulary tuple | `UPPER_SNAKE_CASE` `as const`; derived type PascalCase singular | `<ENTITY>_STATES` / `<Entity>State` |
| Domain executor | `execute<Verb><Entity>` | `executeApprove<Entity>` |
| Rule predicate | `can<Verb>` / `is<Condition>` | `canApprove`, `isTransitionLegal` |
| Trigger registration | `register<Entity>Triggers(triggers)` | exported from the entity, called in root `triggers.ts` |
| Internal-callback file | `<purpose>_functions.ts`, sibling of `<purpose>.ts` | `approval_functions.ts` |
| zodTable export | camelCase plural, same as table | `export const <entities> = zodTable(...)` |
| DTO schema | `<entity><Purpose>Dto` | `<entity>SummaryDto` |
| Zod schema value | camelCase noun | `commandInput`, `publicDto` |
| Type | PascalCase; no `I`/`T` prefixes | `<Entity>State` |
| Test file | `<subject>.test.ts` in `__tests__/` | `commands.test.ts` |
| Public function path | `api/<entity>:<fn>` — clients never call a root path | — |

The two regexes are enforced at runtime: observability silently drops events
whose operation/classification/errorCode don't match. The rest is enforced by
the architecture tests — a naming rule without a test is a wish.

---

## 4. Import rules

Allowed, per zone (anything not listed is forbidden):

| From | May import |
|---|---|
| `api/<entity>.ts` | `functions.ts`, `domain/<entity>/*`, `domain/shared/*`, zod |
| `domain/<entity>/*` | `functions.ts`, `foundation.ts`, component facades, `domain/shared/*`, own directory, generated `internal`/`api` (references only), kit modules |
| `domain/shared/*` | kit modules, vendor SDKs (this is the ONLY home for vendor clients) |
| root facades | kit modules, `components` from generated api |
| `functions.ts` | `_generated/server` (the only file allowed to) |
| `components/<name>/**` | its own directory + npm deps only — no host imports, no `process.env` |

Forbidden everywhere: sibling-entity imports, `api/` from `domain/`,
component internals (anything below a component's client facade),
`makeFunctionReference`, barrel files.

---

## 5. Formatting and language

- TypeScript strict; no `any` in exported signatures; `as never` only at kit
  seams that document it.
- Zod objects that cross a boundary are `.strict()` — always.
- `Object.freeze` for registries and long-lived configuration objects.
- Comments state constraints the code can't (`// Optional only for rows
  created before <epoch>.`) — never narration of the next line.
- One entity concept per file; when a file serves two purposes, split it
  along the anatomy in §2.
