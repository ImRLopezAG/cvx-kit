# Oxlint rules for cvx-kit applications

`cvx-kit/oxlint` is a TypeScript-authored plugin bundled with the package. It
checks applications using the kit against `conventions.md`, the authoritative
source for folder structure and file anatomy. The package repository has a
separate, unpublished plugin for its own `src/` layout.

The consumer plugin was introduced in 0.1.5; the initial 0.1.4 plugin targeted
library authoring. The five architecture rules below were added in 0.1.6. See `upgrading.md` when migrating that configuration.

## Configuration

Install Oxlint as a development dependency and load the plugin in
`.oxlintrc.json`. The root README includes a configuration enabling all rules. The coverage table
below lists all 23 rule names.
Loading a plugin does not enable its rules. For example:

```json
{
	"jsPlugins": [{ "name": "cvx", "specifier": "cvx-kit/oxlint" }],
	"rules": {
		"cvx/no-raw-builders": "error",
		"cvx/domain-import-boundaries": "error",
		"cvx/thin-api-adapters": "error"
	}
}
```

With Vite+, place those fields under `lint` in `vite.config.ts`. The plugin
exports a default plugin object, named `rules`, and the `RuleName` type. It is
tested with Oxlint 1.87.0 and Vite+ 1.1.0.

All rules default to `convex/` relative to the linter's working directory.
For another location, set `convexDir` on **each enabled rule**:

```json
{ "cvx/no-raw-builders": ["error", { "convexDir": "src/server/convex" }] }
```

Source rules ignore files outside that directory, `_generated/`, `__tests__/`,
and test/spec files. `project-structure` reads the whole backend, including tests. They do not
offer automatic fixes for architectural moves.

## Coverage

Every name below has the `cvx/` prefix in lint configuration.

| Rule                           | Detects                                                                                                                                                                                               | Documentation                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `project-structure`            | Root folder allowlist, domain ownership, colocated runnable tests, misplaced tests, symlinks, parse failures, runtime domain-module cycles, and shared implementations with only one domain consumer. | Folder structure and Tests                          |
| `root-wiring-only`             | Unknown root files without a component facade, root function declarations, nondelegating callbacks, branches, loops, direct writes/network calls, and inline root schema construction.                | Root files                                          |
| `application-orchestration`    | Files without two domain dependencies, provider construction, external runtime dependencies, database access, validator construction, and business branches.                                          | Module grain                                        |
| `internal-function-ownership`  | Internal/system registrations at root, in public API adapters, or in domain/shared.                                                                                                                   | Folder structure                                    |
| `domain-file-responsibilities` | Impure rules, query writes/mutations, database access in declarative files, misplaced direct external I/O, and imports that violate these roles.                                                      | File anatomy                                        |
| `root-facade-ownership`        | `createAuthFunctions`, foundation factories, `createTriggers`, `defineRelations`, and `createQueryEngine` outside their root facades, or repeated in one file.                                        | `conventions.md`, Root files                        |
| `no-raw-builders`              | Runtime imports of raw Convex builders outside `functions.ts`; namespace calls to raw generic builders.                                                                                               | `auth.md`; `llms.md`, Non-negotiable rules          |
| `no-handwritten-references`    | Calls to Convex `makeFunctionReference`, including import aliases.                                                                                                                                    | `conventions.md`, Import rules                      |
| `domain-import-boundaries`     | Reverse dependencies into `api/`, domain imports of `application/`, forbidden sibling imports, and API adapters importing another domain module.                                                      | `conventions.md`, Module grain and Import rules     |
| `public-functions-in-api`      | Calls to root `auth*`, `role*`, or `admin*` constructors outside `api/`.                                                                                                                              | `conventions.md`, Folder structure                  |
| `thin-api-adapters`            | `if`, `switch`, ternary branches, top-level private helpers, and direct `ctx.db` writes in `api/`.                                                                                                    | `conventions.md`, The adapter file                  |
| `no-inline-enums`              | Literal arrays passed to imported Zod `enum`. Use named vocabulary tuples.                                                                                                                            | `conventions.md`, Vocabularies                      |
| `no-unbounded-reads`           | Recognized unbounded database/stream/relationship reads and eligibility `.filter()` calls after bounded take/execute/paginate results.                                                                | `llms.md`, Bounded reads; `zod-table.md`            |
| `no-manual-timestamps`         | Explicit `createdAt`/`updatedAt` fields in object literals passed to direct `ctx.db` writes.                                                                                                          | `triggers.md`                                       |
| `component-boundaries`         | Local portable components importing host/sibling files; host imports bypassing component client facades; private package component subpaths.                                                          | `architecture.md`, Injection, not import            |
| `no-component-env`             | Direct `process.env` access, process import aliases, environment destructuring, and named env imports inside local portable components.                                                               | `conventions.md`, Import rules                      |
| `schema-file-boundaries`       | Host `defineTable`, misplaced `defineSchema` or kit table constructors, and misplaced `.table.index/searchIndex/vectorIndex` chains.                                                                  | `conventions.md`, Shapes and topology               |
| `no-internal-reexports`        | Re-exports and import-then-export aliases inside `convex/`.                                                                                                                                           | `conventions.md`, Universal file order              |
| `public-api-first`             | Private function declarations before the last export.                                                                                                                                                 | `conventions.md`, Universal file order              |
| `named-private-helpers`        | Top-level private arrow/function-expression variables.                                                                                                                                                | `conventions.md`, Universal file order              |
| `no-manual-id-projection`      | Adding `id`/`_id` to a recognized table DTO through object spreads or property assignments.                                                                                                           | Public DTO parameters in `zod-table.md`             |
| `no-copied-pagination`         | Zod/native validator objects copying `numItems` + `cursor` or `page` + `isDone` + `continueCursor`.                                                                                                   | Pagination options in `zod-table.md`; `querying.md` |
| `reserved-domain-file-anatomy` | Reserved domain files without their expected declarative schema/contracts/table or Command/Query registry shape.                                                                                      | Reserved domain files below                         |

## Allowed patterns

- `functions.ts` imports raw builders to configure `createAuthFunctions`.
  Type-only imports such as `MutationCtx` from `_generated/server` are valid
  elsewhere. `httpAction` remains available for HTTP routing.
- Domain modules may import sibling `rules.ts` and `queries.ts`, as explicitly
  allowed by the module-grain section. Cross-module writes go through the
  optional `application/` layer. `domain/table.ts` only imports module table maps
  and combines them with `createModule` from `cvx-kit/zod-table`.
- API adapters may delegate and perform the documented bounded inline query
  and DTO projection. `system*` constructors may live in domain modules.
- Authored components under `convex/components/<name>/` may use their own raw
  builders and raw tables. Host-specific facade, timestamp, and bounded-read
  rules do not apply there. Configuration imports for mounting components are
  allowed from root `convex.config.ts`.
- Host schemas use kit table constructors in `domain/<module>/schema.ts` and
  attach indexes in `domain/<module>/table.ts`. `schema.ts` assembles them.
- `archivedAt` remains application-controlled. Singular `db.get` reads and
  bounded `execute`/`paginate` calls are allowed.

## DTO and pagination diagnostics

Enable the new diagnostics alongside the existing architecture rules:

```json
{
	"rules": {
		"cvx/no-manual-id-projection": "error",
		"cvx/no-copied-pagination": "error",
		"cvx/no-unbounded-reads": "error",
		"cvx/root-facade-ownership": "error",
		"cvx/root-wiring-only": "error",
		"cvx/reserved-domain-file-anatomy": "error"
	}
}
```

### `no-manual-id-projection`

Recognizes a table DTO projection/parse, including supported binding aliases,
then reports adding `id` or `_id` by a spread or property assignment:

```ts
// Reported
const output = { ...tasks.toPublicDto(row), _id: row._id }
const parsed = tasks.publicDto.parse(input)
parsed.id = row._id

// Use the matching projection and return boundary
const outputWithId = tasks.toPublicDto(row, true)
const returns = tasks.dto(true)
```

The helper returns `_id`, not an `id` alias. For computed fields use the
validated `extend`/`values` API described in [zod-table.md](./zod-table.md).
The rule depends on recognized table/DTO provenance; it does not treat every
object named `dto` as a kit boundary or prove all runtime projection paths safe.

### `no-copied-pagination`

Reports recognized `z.object`/Convex `v.object` shapes containing both `numItems`
and `cursor`, or all three of `page`, `isDone`, and `continueCursor`:

```ts
// Reported
const options = z.object({ numItems: z.number(), cursor: z.string().nullable() })
const result = z.object({
	page: z.array(tasks.publicDto),
	isDone: z.boolean(),
	continueCursor: z.string(),
})

// Table query input and relation-aware output
const options = tasks.paginationOpts({ status: true })
const result = relations.tables.tasks.pageDto({})
```

For ordinary native pagination, retain `paginationOptsValidator` (bridge through
`convexToZod` when needed) or `paginated(tasks.dto())`. These preserve native
validators instead of copying their current fields. Application-specific fields
can extend the derived Zod object. Use the engine's `paginationOpts` for its
selected filters and order; a native options validator alone supplies neither.

### `no-unbounded-reads`

The existing rule now follows recognized native, kit `include`, stream, and
relationship read chains. It reports unbounded `collect()`/`resolve()` where
supported provenance is known, and `.filter()` on recognized bounded results:

```ts
// Reported: eligible rows outside the first 25 can be missed
const rows = await ctx.db.query('tasks').take(25)
const eligible = rows.filter((task) => task.status === 'open')

// Put eligibility into the query before page filling
const page = await querying(ctx).tasks.where({ status: 'open' }).paginate(args)
```

Choose an indexed native constraint where appropriate, or express the predicate
through the querying engine. Many relationships use bounded pages and separate
continuation endpoints. There is no automatic predicate-movement fix: moving a
predicate can change authorization, ordering, and continuation semantics.

### Relation and engine facade ownership

`root-facade-ownership` requires `defineRelations` in `convex/relations.ts` and
`createQueryEngine` in `convex/querying.ts`, each configured once. The same rule
continues to enforce auth, triggers, and foundation facades.

`root-wiring-only` and the whole-project checker permit these root files only
as narrow declarative factory configurations. `relations.ts` can import domain
schema/table declarations (including the domain table assembly); `querying.ts`
can import domain query/contract modules where permitted. Neither file is a
place for endpoint handlers, business branches, or direct database operations.
Domain contracts derive validators, domain Query registries own handlers, and
`api/` adapters delegate through authenticated constructors. See
[querying.md](./querying.md) and [conventions.md](./conventions.md).

## What still needs review and tests

These are syntax and lexical-binding checks, not whole-program validation.
Import-boundary rules resolve relative imports and tsconfig aliases (including
extended configs) using the package resolver. Symlinked source is rejected by
the project scan. Computed import paths are not resolved. Named import aliases and namespaces are recognized where documented;
General variable reassignment, arbitrary wrappers, and destructured database
methods are not whole-program traced. DTO/read checks do follow supported local
initializers, aliases, awaited results, and recognized helper chains; unrelated
user functions and unknown provenance remain outside that bounded analysis. Database checks
recognize the documented `ctx.db` member shape, not its runtime type.

The plugin does not prove DTO redaction, complete command/audit coverage,
tenant/RLS correctness, unique table ownership across files, required facade
existence, exactly one component mount, numeric read limits, or vocabulary
tuple ownership. Run the behavioral tests described in `maintainability.md`. The package owns
structural enforcement; applications do not need copied architecture tests. A clean lint run is not
evidence of those runtime guarantees.

## Whole-project validation

Enable `cvx/project-structure` and lint the **whole** configured backend. The
scan reports on `convex.config.ts`, or the first non-test source file if no
configuration file exists. That anchor must be part of the lint invocation;
changed-file-only runs and cached lint runs can skip project checks. Use a full,
uncached lint run in CI. The scan ignores generated code, reads current files on
every invocation, and does not execute application code.

For standalone tooling, including an empty/missing backend, use the same packaged
checker directly:

```ts
import { checkArchitecture } from 'cvx-kit/oxlint'

const issues = checkArchitecture({ cwd: process.cwd(), convexDir: 'convex' })
for (const issue of issues) console.error(`${issue.file}: ${issue.message}`)
if (issues.length) process.exitCode = 1
```

No fixed module scaffold is required. Type-only modules and grouping folders
need no test directory. Runtime schema/constants files do; root wiring shares
root tests. Test files must be directly inside the owning `__tests__/` directory.
Recognized test entrypoints are `test`/`it` globals and imports from Vitest,
Vite+, Bun, Node, or Jest, including import aliases and namespaces. Empty,
TODO, skipped, and conditionally skipped/run tests do not satisfy the minimum.
A nonempty callback is a presence check, not evidence of meaningful assertions,
execution, or coverage. Run the tests in CI.

Cycle detection operates on runtime ESM imports/re-exports and literal dynamic
imports between `domain/<module>` owners, including nested files. Type-only
imports do not create runtime cycle edges. Arbitrary CommonJS wrappers, computed
imports, implicit generated function-reference calls, and value flow are not
whole-program analyzed. Rules report recognizable violations; clean lint does
not prove arbitrary business logic is absent.

Shared ownership follows static runtime imports through shared helpers. A shared
file reached from only one domain is reported for relocation. Unused code,
type-only consumers, and computed dependencies are not treated as proof of shared
ownership; their ownership still needs review.

## Reserved domain files

Enable `cvx/reserved-domain-file-anatomy` to require exported Command/Query registries, declarative contracts, zodTable shapes, and table topology or createModule assembly. Constructor provenance is traced through imported aliases, namespaces, direct Foundation factories, and the root foundation.ts facade. Pair it with `cvx/domain-file-responsibilities` to reject handlers and database/runtime work in contracts.ts. Backend scope and test/generated exclusions apply; absent files are not required.
