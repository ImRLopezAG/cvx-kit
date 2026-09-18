# Oxlint rules for cvx-kit applications

`cvx-kit/oxlint` is a TypeScript-authored plugin bundled with the package. It
checks applications using the kit against `conventions.md`, the authoritative
source for folder structure and file anatomy. The package repository has a
separate, unpublished plugin for its own `src/` layout.

The correction described here is unreleased; the initial 0.1.4 plugin targeted
library authoring. See `upgrading.md` when migrating that configuration.

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

Rules ignore files outside that directory, `_generated/`, `__tests__/`, and
files ending in `.test` or `.spec` before their JS/TS extension. They do not
offer automatic fixes for architectural moves.

## Coverage

Every name below has the `cvx/` prefix in lint configuration.

| Rule                        | Detects                                                                                                                                          | Documentation                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `root-facade-ownership`     | `createAuthFunctions`, `createTriggers`, and `new Foundation` outside their root files, or repeated in one file.                                 | `conventions.md`, Root files                    |
| `no-raw-builders`           | Runtime imports of raw Convex builders outside `functions.ts`; namespace calls to raw generic builders.                                          | `auth.md`; `llms.md`, Non-negotiable rules      |
| `no-handwritten-references` | Calls to Convex `makeFunctionReference`, including import aliases.                                                                               | `conventions.md`, Import rules                  |
| `domain-import-boundaries`  | Reverse dependencies into `api/`, domain imports of `application/`, forbidden sibling imports, and API adapters importing another domain module. | `conventions.md`, Module grain and Import rules |
| `public-functions-in-api`   | Calls to root `auth*`, `role*`, or `admin*` constructors outside `api/`.                                                                         | `conventions.md`, Folder structure              |
| `thin-api-adapters`         | `if`, `switch`, ternary branches, top-level private helpers, and direct `ctx.db` writes in `api/`.                                               | `conventions.md`, The adapter file              |
| `no-inline-enums`           | Literal arrays passed to imported Zod `enum`. Use named vocabulary tuples.                                                                       | `conventions.md`, Vocabularies                  |
| `no-unbounded-reads`        | Direct `ctx.db.query(...).collect()` chains and `ctx.include(...).resolve()` chains in host code.                                                | `llms.md`, Bounded reads; `zod-table.md`        |
| `no-manual-timestamps`      | Explicit `createdAt`/`updatedAt` fields in object literals passed to direct `ctx.db` writes.                                                     | `triggers.md`                                   |
| `component-boundaries`      | Local portable components importing host/sibling files; host imports bypassing component client facades; private package component subpaths.     | `architecture.md`, Injection, not import        |
| `no-component-env`          | Direct `process.env` access, process import aliases, environment destructuring, and named env imports inside local portable components.          | `conventions.md`, Import rules                  |
| `schema-file-boundaries`    | Host `defineTable`, misplaced `defineSchema` or kit table constructors, and misplaced `.table.index/searchIndex/vectorIndex` chains.             | `conventions.md`, Shapes and topology           |
| `no-internal-reexports`     | Re-exports and import-then-export aliases inside `convex/`.                                                                                      | `conventions.md`, Universal file order          |
| `public-api-first`          | Private function declarations before the last export.                                                                                            | `conventions.md`, Universal file order          |
| `named-private-helpers`     | Top-level private arrow/function-expression variables.                                                                                           | `conventions.md`, Universal file order          |

## Allowed patterns

- `functions.ts` imports raw builders to configure `createAuthFunctions`.
  Type-only imports such as `MutationCtx` from `_generated/server` are valid
  elsewhere. `httpAction` remains available for HTTP routing.
- Domain modules may import sibling `rules.ts` and `queries.ts`, as explicitly
  allowed by the module-grain section. Cross-module writes go through the
  optional `application/` layer. `domain/table.ts` combines module table maps.
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
They resolve relative import paths, not tsconfig aliases, symlinks, or computed
paths. Named import aliases and namespaces are recognized where documented;
arbitrary variable reassignment, wrapper functions, destructured database
methods, and calls split across variables are not traced. Database checks
recognize the documented `ctx.db` member shape, not its runtime type.

The plugin does not prove DTO redaction, complete command/audit coverage,
tenant/RLS correctness, unique table ownership across files, required facade
existence, exactly one component mount, numeric read limits, or vocabulary
tuple ownership. Keep the architecture tests from `conventions.md` and the
behavioral tests described in `maintainability.md`. A clean lint run is not
evidence of those runtime guarantees.
