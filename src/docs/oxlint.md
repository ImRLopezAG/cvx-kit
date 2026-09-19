# Oxlint rules for cvx-kit applications

`cvx-kit/oxlint` is a TypeScript-authored plugin bundled with the package. It
checks applications using the kit against `conventions.md`, the authoritative
source for folder structure and file anatomy. The package repository has a
separate, unpublished plugin for its own `src/` layout.

The consumer plugin was introduced in 0.1.5; the initial 0.1.4 plugin targeted
library authoring. The five architecture rules below are additions for the next
release. See `upgrading.md` when migrating that configuration.

## Configuration

Install Oxlint as a development dependency and load the plugin in
`.oxlintrc.json`. The root README includes a configuration enabling all rules.
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
tested with Oxlint 1.79.0 and Vite+ 0.3.0.

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

| Rule                           | Detects                                                                                                                                                                                               | Documentation                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `project-structure`            | Root folder allowlist, domain ownership, colocated runnable tests, misplaced tests, symlinks, parse failures, runtime domain-module cycles, and shared implementations with only one domain consumer. | Folder structure and Tests                      |
| `root-wiring-only`             | Unknown root files without a component facade, root function declarations, nondelegating callbacks, branches, loops, direct writes/network calls, and inline root schema construction.                | Root files                                      |
| `application-orchestration`    | Files without two domain dependencies, provider construction, external runtime dependencies, database access, validator construction, and business branches.                                          | Module grain                                    |
| `internal-function-ownership`  | Internal/system registrations at root, in public API adapters, or in domain/shared.                                                                                                                   | Folder structure                                |
| `domain-file-responsibilities` | Impure rules, query writes/mutations, database access in declarative files, misplaced direct external I/O, and imports that violate these roles.                                                      | File anatomy                                    |
| `root-facade-ownership`        | `createAuthFunctions`, `createTriggers`, and `new Foundation` outside their root files, or repeated in one file.                                                                                      | `conventions.md`, Root files                    |
| `no-raw-builders`              | Runtime imports of raw Convex builders outside `functions.ts`; namespace calls to raw generic builders.                                                                                               | `auth.md`; `llms.md`, Non-negotiable rules      |
| `no-handwritten-references`    | Calls to Convex `makeFunctionReference`, including import aliases.                                                                                                                                    | `conventions.md`, Import rules                  |
| `domain-import-boundaries`     | Reverse dependencies into `api/`, domain imports of `application/`, forbidden sibling imports, and API adapters importing another domain module.                                                      | `conventions.md`, Module grain and Import rules |
| `public-functions-in-api`      | Calls to root `auth*`, `role*`, or `admin*` constructors outside `api/`.                                                                                                                              | `conventions.md`, Folder structure              |
| `thin-api-adapters`            | `if`, `switch`, ternary branches, top-level private helpers, and direct `ctx.db` writes in `api/`.                                                                                                    | `conventions.md`, The adapter file              |
| `no-inline-enums`              | Literal arrays passed to imported Zod `enum`. Use named vocabulary tuples.                                                                                                                            | `conventions.md`, Vocabularies                  |
| `no-unbounded-reads`           | Direct `ctx.db.query(...).collect()` chains and `ctx.include(...).resolve()` chains in host code.                                                                                                     | `llms.md`, Bounded reads; `zod-table.md`        |
| `no-manual-timestamps`         | Explicit `createdAt`/`updatedAt` fields in object literals passed to direct `ctx.db` writes.                                                                                                          | `triggers.md`                                   |
| `component-boundaries`         | Local portable components importing host/sibling files; host imports bypassing component client facades; private package component subpaths.                                                          | `architecture.md`, Injection, not import        |
| `no-component-env`             | Direct `process.env` access, process import aliases, environment destructuring, and named env imports inside local portable components.                                                               | `conventions.md`, Import rules                  |
| `schema-file-boundaries`       | Host `defineTable`, misplaced `defineSchema` or kit table constructors, and misplaced `.table.index/searchIndex/vectorIndex` chains.                                                                  | `conventions.md`, Shapes and topology           |
| `no-internal-reexports`        | Re-exports and import-then-export aliases inside `convex/`.                                                                                                                                           | `conventions.md`, Universal file order          |
| `public-api-first`             | Private function declarations before the last export.                                                                                                                                                 | `conventions.md`, Universal file order          |
| `named-private-helpers`        | Top-level private arrow/function-expression variables.                                                                                                                                                | `conventions.md`, Universal file order          |

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

## What still needs review and tests

These are syntax and lexical-binding checks, not whole-program validation.
Import-boundary rules resolve relative imports and tsconfig aliases (including
extended configs) using the package resolver. Symlinked source is rejected by
the project scan. Computed import paths are not resolved. Named import aliases and namespaces are recognized where documented;
arbitrary variable reassignment, wrapper functions, destructured database
methods, and calls split across variables are not traced. Database checks
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
