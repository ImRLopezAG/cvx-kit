# Repository lint rules

`bun run lint` runs Oxlint through Vite+. CI runs the same command and the
custom rule tests in a separate job. `bun run check` also checks formatting;
`bun run typecheck` checks the library and its TypeScript tests.

All 15 generic rules in `anti-slop/` are enabled as errors. That directory is
vendored from the install-anti-slop skill. The repository's six library rules
live in `cvx/index.ts` and are loaded by `vite.config.ts`. These checks target
this package's `src/` layout and export map; they are not published.

The separate consumer plugin in `src/oxlint.ts` is built and published as
`cvx-kit/oxlint`. Its 15 rules target applications under `convex/`, following
the kit's documented API/domain/facade conventions. Both plugins are tested
in `cvx/index.test.mjs`. Consumer setup is in the root README and coverage is
documented in [`src/docs/oxlint.md`](../../src/docs/oxlint.md).
Oxlint and `@oxlint/plugins` are pinned to 1.79.0, matching Vite+ 0.3.0's
embedded lint dependencies. Upgrade them together. No manifest declares
Effect, so its optional plugin is not enabled.

## Library conventions

These rules apply to handwritten `src/**/*.ts`, excluding behavioral tests
and the `src/test.ts` component-registration helper. Generic anti-slop rules
still apply to tests, scripts, configuration, and our custom lint plugin.
Generated Convex files, build output, agent assets, and vendored anti-slop
code are excluded from both lint and formatting.

| Rule                         | Enforced behavior                                                                                                                                                                                                                                        | Source                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `cvx/component-boundaries`   | Components import their own files or npm dependencies; other library modules reach components through `client.ts`. Components cannot self-import `cvx-kit`. Checks imports, re-exports, literal dynamic imports, import types, and unshadowed `require`. | `src/docs/architecture.md`, Injection, not import                                       |
| `cvx/no-component-env`       | No direct `process.env`, computed access, environment destructuring, or named env imports inside components; recognizes imported process aliases and local shadowing.                                                                                    | `src/docs/conventions.md`, Import rules                                                 |
| `cvx/schema-file-boundaries` | Component `defineSchema` calls belong in `schema.ts`; `defineTable` calls belong in `schema.ts` or `table.ts`. Recognizes aliases and namespace imports from `convex/server`.                                                                            | `src/docs/architecture.md`, Conventions worth enforcing                                 |
| `cvx/no-internal-reexports`  | Re-export only from root modules declared in `package.json` exports, `src/index.ts`, or component `client.ts` facades. Local declarations may still be exported separately.                                                                              | `src/docs/conventions.md`, Universal file order; library entry points in `package.json` |
| `cvx/public-api-first`       | Top-level private function declarations follow the last export; separately exported functions remain public.                                                                                                                                             | `src/docs/conventions.md`, Universal file order                                         |
| `cvx/named-private-helpers`  | Top-level private functions use named declarations. Exported functions and inline callbacks may use arrows.                                                                                                                                              | `src/docs/conventions.md`, Universal file order                                         |

The conventions document also describes **consumer application** folders such
as `convex/api/` and `convex/domain/`. This repository implements the kit, so
those application-only constraints are not applied to its library internals.
In particular, raw Convex builders are legitimate inside components, and the
package index and component clients are intentional public facades.

These are syntax and lexical-binding checks, not whole-program proofs.
Import boundaries resolve relative paths; they do not resolve tsconfig aliases,
symlinks, or computed import paths. Environment and schema checks do not follow
arbitrary variable assignments or wrapper functions. Public-first checks order
private function implementations, not every constant or type declaration.
Dependency injection, adapter thinness, runtime validation, and consumer domain
ownership still require review and behavioral tests.

## Rule development

`bun run test:lint` exercises real Oxlint parsing and diagnostics through
`RuleTester`. Every rule has allowed and rejected fixtures. Add regression
cases for aliases, shadowed names, and public facades when changing rules.
Do not add automatic fixes for architectural moves: moving a declaration or
changing an import can alter initialization order or API contracts.

The 2026-09-18 migration removed the initial 383 errors from owned source
and tests. Keep all rules enabled. Preserve schema-derived input/output types,
use the real Convex data model in fixtures, and document the invariant behind
unavoidable mapped-key or callback-registry assertions. Invalid-input tests
use explained `@ts-expect-error` directives so the runtime rejection remains
covered without pretending the invalid value is valid.

Format owned files with `vp fmt`; do not bulk-format unrelated untracked work.
`vp check` accepts explicit file paths when a checkout includes personal drafts.

`bun run test:package:oxlint` installs the tarball with npm and Bun, loads
`cvx-kit/oxlint` in the real Oxlint CLI, checks valid consumer adapters and all
15 consumer rule diagnostics, and
typechecks the published declarations. CI runs this after building. The
`@oxlint/plugins` type dependency is shipped so consumers can resolve those
declarations; the Oxlint executable remains a development dependency.

Plugin API references: [Oxlint custom rule testing](https://oxc.rs/docs/guide/usage/linter/writing-js-plugins)
and [Vite+ lint configuration](https://www.viteplus.dev/guide/lint).
