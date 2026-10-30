# Changelog

All notable changes to cvx-kit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**Semver contract (from 0.1.0):** while on 0.x, breaking changes land only on
minor bumps; patches are additive or fixes. The breaking window formally
closes at the follow-up consolidation release (package-name decision + full
export-name API audit) — until then, the six 0.1.0 helper surfaces may still
be renamed in a minor. Every release tag gets a GitHub Release whose notes
are this file's matching section.

## [Unreleased]

## [0.1.25] - 2026-10-30

### Changed

- Defer each relation table's registration work to its first use: schema helpers, an engine read, or a selected relation that reaches it, including a through relation's junction. `defineRelations` now checks only table names, native table ownership and relation declaration structure, so a registry module costs little to import when a function uses few of its tables. Variant tables still run native table preflight at registration.
- Check each relation edge's field types and supporting indexes on its first read; an edge's targets need only their stored side for that check.
- Compute the registry identity, metadata snapshots and stream schema on demand. Their values are unchanged, so existing cursors stay valid. Engine page requests still bind cursors to the full identity and so still materialize every table.
- Invalid tables and edges now throw on first use instead of at registration, and later changes to a table's source definitions are ignored only after its first use.

### Added

- `verifyRelations(relations)` runs every deferred registration check now, so a test can fail CI on an invalid registry.
- A registration benchmark: `node scripts/bench-relations.mjs`.

## [0.1.24] - 2026-10-28

### Changed

- Defer eligible private relation DTO reconstruction until projection while keeping registration validation, schema capture and registry identity eager. Public helper schemas remain independent.
- Reduce constructor-dispatch work for ordinary schemas on the audited Zod versions, retaining the original scan for other versions and custom readers. Side-effecting Proxies around Zod internals are unsupported.
- Capture each registered function's top-level argument fields once and reuse its argument object schema; parsing, defaults, refinements and transforms still run on every invocation.

### Added

- Pass the already resolved identity as the second `getAuthUser` argument so consumers can avoid another identity lookup. Existing one-argument callbacks remain supported.

## [0.1.23] - 2026-10-26

### Added

- Opt into compact pagination filter validators with `paginationOpts(selection, { validator: 'compact' })` on tables and relations, retaining precise common generated types and full semantic validation before customization or handlers.
- Export `PaginationFiltersInput` from `cvx-kit/relations` for full-depth filter literals.

### Changed

- Reduce the three-field/13-literal fixture's registered validator by 29.22 times and generated argument declarations by 35.85 times. Native ID-heavy paths retain their validators and can limit compression; default conversion is unchanged.

## [0.1.22] - 2026-10-26

### Added

- Compose domain error contracts with `combineErrorContracts`, preserving the union of declared codes and details.
- Construct validated transport payloads with contract `envelope` and `toConvexError`, and select declared failures with `failureOf` and `isFailure`.
- Opt into original-error React boundaries with `usePaginatedList({ onFailure: 'throw' })`, or inspect the raw `error` alongside the decoded failure.

### Fixed

- Decode one bounded JSON envelope from serialized `ConvexError.data`, using the same strict validation as object payloads.
- Preserve invalid-cursor recovery before list failure throwing, with subscription cleanup and fresh-epoch boundary retry.

## [0.1.21] - 2026-10-25

### Added

- Add typed index ordering, native range bounds, and ordered multi-value traversal for authorized queries.
- Expose page completeness and safe budget continuation, policy-gated field groups, and managed public cursor codecs.
- Export browser-safe filter contracts, typed client failures, React mutation commands, reactive paginated lists, and conservative optimistic list updates.
- Support root native full-text search with authenticated continuation, authorized relation expansion, and React search journals. Search targets and scan limits are admission thresholds; reactive native windows can exceed them.
- Document the new APIs and their authorization, budget, and continuation contracts in the repository-hosted AI skill.

### Changed

- Update development compatibility to Convex 1.48.0 and convex-helpers 0.1.129 while retaining packed consumer coverage for the advertised minimum peers.

## [0.1.20] - 2026-10-18

### Changed

- Reduce repeated schema integrity checks, filter parsing, and DTO construction work during relational queries while preserving existing public APIs.
- Reuse variant field lists and DTO reconstruction factories while validating current row values on every call and returning independent mutable schemas.

### Fixed

- Preserve supported Zod constructor compatibility, live refinement callbacks, native ID validation, and schema mutation isolation across optimized query boundaries.

## [0.1.19] - 2026-10-13

### Added

- Export `createTable` to reuse a shared object of Zod field validators across ordinary table declarations, preserving `zodTable` boundaries, native IDs, field masks, tools, and index inference.
- Reject table-specific declarations that duplicate shared field names, with runtime checks and static rejection for known keys.
- Document reusable table fields in the README and repository-hosted skill.

## [0.1.18] - 2026-10-13

### Added

- Select registered native-ID union members with `forTable` for direct forward and indexed inverse relations, including generated variant-table targets.
- Preserve authorization, bounded pagination, and cursor identity for selected ID members without changing the stored union or root DTO.
- Document native-ID relation wiring, independent link authorization, and additive migration with resumable backfill and rollback.

### Fixed

- Preserve explicit timestamp validators and ordinary boundary masks in `zodVariantTable` when `timestamps: false`, including required server-owned ledger timestamps.
- Reuse equivalent bounded filter grammar and schema nodes so dense relation graphs fit within Convex's module memory limit.

### Compatibility

- Branch-scoped field narrowing and narrowed junction joins are explicitly unsupported in this release; existing branch and junction declarations remain supported.
- Relation declaration changes invalidate prior cursors and require pagination to restart.

## [0.1.17] - 2026-10-13

### Added

- Register generated variant boundaries in relations and the shared authorized query engine, retaining discriminated DTOs and native branded IDs.
- Declare guarded branch references and branch filter allowlists/predicates for direct, nested, and junction relationships.
- Verify installed variant query consumers with sanctioned Convex codegen and native write/read flows.

### Changed

- Run bounded integration tests in CI while retaining the full local unit and relational stress suites.
- Run packed component smoke jobs independently of the main verification job.
- Document complete variant-table registration, authenticated queries, filtering, and continuation in the repository skill.

## [0.1.16] - 2026-10-13

### Added

- Opt-in `zodVariantTable` command, insert, update, public DTO, and tool boundaries with per-variant masks, native storage IDs, and strict discriminators.
- Repository-hosted `cvx-kit` agent skill, installable from GitHub through the skills CLI, with task-specific access to the full documentation.

### Changed

- Keep documentation in `skills/cvx-kit/references` and ship only the README as npm documentation.
- Verify portable skill references in CI and before publication; remove obsolete planning and explainer artifacts.

### Fixed

- Preserve optional/nullable refinements in derived tool inputs and reject bigint command literals before JSON Schema generation.

## [0.1.15] - 2026-10-11

### Added

- Declare a global query engine with only `createQueryEngine({ schema, relations })`.
- Load cursor secrets internally from server environment configuration on first pagination.
- Configure optional engine overrides in a separate second argument, while preserving existing declarations.

### Changed

- Document global engine setup, server cursor secrets, and the purpose of advanced options.
- Publish releases after successful CI for the exact main commit, without repeating tests in the release workflow.

## [0.1.14] - 2026-10-11

### Added

- Typed relational queries with scalar and relationship filters, conditional indexes, global ascending or descending order, and bounded stream pagination.
- Explicit relationship declarations for direct, self, and junction relationships, with paginated child continuations.
- Managed query authorization, shared read budgets, and encrypted cursors bound to the query, principal, tenant, and parent relationship.
- Table DTO options for validated IDs and extensions, including `toPublicDto(row, true)`, plus native-derived `paginationOpts` and page DTO helpers.
- Oxlint enforcement for manual ID projections, copied pagination contracts, and unsafe relational query boundaries.
- Dedicated querying documentation and updated table and rule documentation in `src/docs`.

### Fixed

- Preserve shared validator graphs during native auth registration to avoid repeated validator expansion.

### Verified

- Source, type, rule, and packed-consumer checks; 308 independently audited relational stress sequences across installed and minimum peer versions.
- 33 HTTP responses exercised encrypted cursor pagination and rejection paths on a local Convex backend. Hosted production performance remains unmeasured.

## [0.1.13] - 2026-10-10

### Added

- Implement contracted operations with `command.handler(handler, options?)` and
  `query.handler(handler, options?)` in both Promise and Effect registries.
- Infer each handler's input and result from its operation object key, without
  repeating the operation name; preserve existing named helpers.

### Verified

- Cover contract binding, validation, audits, and handler inference with 684
  runtime tests and strict type fixtures.
- Compile the documentation examples and test packed npm/Bun consumers with
  and without Effect.

## [0.1.12] - 2026-10-10

### Added

- Declare optional domain contracts with root errors, command classification,
  and exact command/query implementation keys in both Effect and Promise registries (#26).
- Share a registry-level command audit default with per-operation overrides,
  preserving replay bypass, schema inference, and transactional rollback.
- Use `createFoundation` for typed Promise registries without installing Effect.
- Enforce reserved domain file declarations through the packaged Oxlint plugin,
  including constructor provenance and declarative contract ownership.
- Document both contract APIs with packed-compiled examples and audit guidance.

### Verified

- Cover native validation, error projection, rollback, audit selection, agent tools,
  workflow integration, and npm/Bun consumers with and without Effect.
- Pass 680 runtime tests, 340 lint-rule tests, and both packed-component CI smoke tests.

## [0.1.11] - 2026-10-09

### Added

- Configure shared post-auth Effect services and command/query handles once across
  all auth, role, admin, and system constructors with `createEffectAuthFunctions` (#24).
- Keep query, mutation, action, and internal system capabilities separately typed
  and configured; preserve secured database wrapping and live action membership.
- Document the shared application factory with packed-compiled examples and
  constructor capability guidance for coding agents.

### Verified

- Cover denied authentication, roles and membership, request-local scopes, context
  collisions, nested command auditing, and registered mutation rollback.
- Preserve packed native auth context compatibility on Convex 1.45 and 1.46.

## [0.1.10] - 2026-10-09

### Fixed

- Preserve native Convex context types in auth, role, admin, and system function
  constructors so secured handlers bind directly to Effect registries (#22).
- Install Standard Schema types explicitly so native contract input and output
  inference works in clean installations.

### Changed

- Update package dependencies and migrate the development toolchain to Vite+ 1.1.
- Require Convex 1.46 or newer and convex-helpers 0.1.127 or newer (below 0.2.0),
  matching workflow 0.4.10.

## [0.1.7] - 2026-10-07

### Added

- Add optional Effect 4 command and query registries with cohesive ordinary,
  Promise, generator, and function handlers, injected services, and scoped API
  execution through native and custom Convex builders.
- Add asynchronous operation contracts, explicit schema adapters, and checked
  transport for declared safe errors.
- Add injectable audited Effect CRUD, host-owned transactional idempotency
  receipts, native durable workflow bindings, and selected domain operation tools.
- Document server-side declaration, composition, API consumption, receipts,
  workflows, and tools with compile-checked public-package examples.

### Fixed

- Preserve native validators, trusted authorization, RLS, triggers, audit, and
  rollback across API, workflow, and tool integrations.
- Reconcile late workflow outcomes without allowing stale generations or late
  completion to overwrite canceled runs.
- Validate retained receipt versions before fingerprints and replay, and require
  current authorization before disclosing replayed results.

## [0.1.6] - 2026-09-19

### Added

- Add five opt-in consumer Oxlint rules for project structure, root wiring,
  application orchestration, internal function ownership, and domain file
  responsibilities. The packaged plugin now includes 20 rules.
- Check colocated test presence, runtime import cycles, and shared-code ownership.
  Export `checkArchitecture` for standalone checks without copying architecture
  test suites into applications. These static checks do not replace behavior tests.

### Fixed

- Resolve tsconfig aliases when checking consumer import boundaries and reject
  migration dependencies from application code.
- Enforce documented ownership of domain implementations, table aggregation,
  query side effects, and component boundaries.

## [0.1.5] - 2026-09-18

### Fixed

- Correct `cvx-kit/oxlint` to enforce the documented consumer `convex/` layout
  rather than this repository's `src/` layout. Keep the six library-authoring
  rules in repository tooling and publish 15 consumer rules, with coverage for
  domain boundaries, auth builders, thin adapters, facade ownership, table
  placement, vocabularies, bounded read syntax, and trigger-owned timestamps.
- Replace consumer `entryPoints`/`packageName` options with `convexDir`; document
  migration, allowed exceptions, and the checks that still need runtime tests.
  Validate the packaged plugin against consumer fixtures installed by npm and Bun.

## [0.1.4] - 2026-09-18

### Added

- Publish the TypeScript Oxlint plugin as `cvx-kit/oxlint`, with six rules for
  component isolation, environment access, schema placement, public facades,
  API ordering, and named private helpers. Consumer entry points and package
  self-import boundaries are configurable.
- Enforce all 15 generic anti-slop rules in the repository and verify the
  published plugin through fresh npm and Bun installations in CI.

### Changed

- Replace cast-heavy command, CRUD, tenancy, auth, webhook, and tool boundaries
  with schema-derived types and validation. Preserve distinct agent-tool result
  types and validate the emitted declarations in packed consumers.
- Tighten TypeScript contracts for query middleware, include transforms, audit
  metadata, and webhook targets. See `docs/upgrading.md` for migration details.
- Format owned source, tests, scripts, and documentation consistently.

## [0.1.3] - 2026-09-06

### Fixed

- Fix Convex ID validation across package boundaries by sharing `convex-helpers`
  as a peer dependency. Export `zid`, `zodToConvex`, and `convexToZod` from
  `cvx-kit/zod-table`; verify differing compatible host versions under npm and Bun (#10).
- Add `Command.withContext<Context, Extension>()` for schema-inferred guards,
  audit callbacks, operation middleware, and correlated registry middleware (#11).
- Add invocation-local `prepare` hooks with authorized, validated replay and
  completion after audit, inside observation. Durable storage remains host-owned (#12).
- Accept concrete and generic `convex-test` backends directly in registration helpers (#13).
- Parse command results once after middleware; handler and middleware result types
  describe schema inputs, while audit, completion, and executor results describe outputs.
- Accept raw command schema inputs at executor call sites while inferring parsed
  outputs for callbacks; reject incompatible typed host contexts and registry middleware.
- See `docs/upgrading.md` for helper peer installation and transformed-result migration.

## [0.1.2] - 2026-08-21

### Added

- `resolveOrganization` hook on `createAuthFunctions`: identity providers
  whose tokens carry no org claims (custom credentials, magic codes,
  memberships in app tables) can resolve organization and role from the
  database. When configured, the hook overrides claim-based resolution and
  fails closed — `null` or an error rejects with `FORBIDDEN`; its `roleSlug`
  still passes `mapRole`, tenancy derives from the hook's organization, and
  `verifyMembership` for actions is unchanged. Hook-less configurations are
  unaffected. ([#8](https://github.com/ImRLopezAG/cvx-kit/issues/8))

## [0.1.1] - 2026-08-17

### Fixed

- Package Convex component schemas exclusively as discoverable `schema.js` and
  `schema.d.ts` files. This restores the approvals tables and the
  `approvalDecisions.by_runId_and_decidedAt` and
  `approvalDecisions.by_runId_and_stepKey_and_actor_actorRef` indexes without
  consumer `patchedDependencies` workarounds or canonicalization conflicts.
- Keep compiled component imports aligned with the discoverable `schema.js`
  filename when runtime functions use the schema directly.
- Include `stepKey` in the public approval callback evidence contract and
  export canonical Zod and Convex callback validators for strict consumers.
- Use component-safe cursor pagination for approval request lists instead of
  Convex's app-only built-in `.paginate()` implementation.

### Added

- Packed-tarball content checks and clean anonymous-deployment smoke tests for
  every bundled component under both Bun and npm installation.
- `components.approvals.health.check`, which verifies the approvals schema
  version and required decision indexes with an actionable failure diagnostic.
- Supported Convex, Zod, Bun, Node.js, and npm versions plus an approvals
  packaging migration note.
- Packed callback and paginated-list smoke coverage through real host wrappers.

## [0.1.0] - 2026-08-14

The big one: the full helper surface, in one release.

### Added

- **Pagination bridge** — `paginated(dto)` boundary schemas
  (`cvx-kit/zod-table`) and an `include(...).paginate(opts, transform?)`
  terminal (`cvx-kit/auth`): cursor pagination bounded by the same maxRows
  policy as `execute`. Under row-level security, pages may be shorter than
  `numItems` (filtered rows); cursors remain correct.
- **CRUD command factory** — `createCrudCommands` (`cvx-kit/crud`):
  create/update/archive operations generated from a zodTable, fully inside
  the audited command pipeline; soft-delete only; `enrich` is required for
  tenantTables (fails fast with `CRUD_ENRICH_REQUIRED`).
- **State-machine helper** — `createStateMachine` (`cvx-kit/state-machine`):
  typed transition legality from constants tuples; `assert` throws
  `INVALID_TRANSITION` via the injected ErrorFactory, dropping straight into
  command guards.
- **Rate-limit middleware** — `rateLimit` (`cvx-kit/middleware`): the first
  packaged middleware, over an injected `@convex-dev/rate-limiter` instance
  (structural typing — zero new kit dependencies). Keyed by `ctx.tenant` by
  default; a missing key is a configuration error
  (`RATE_LIMIT_KEY_MISSING`), never a silent shared bucket.
- **Webhook boundary** — `createWebhookBoundary`, `recordWebhookEvent`,
  `webhookEventsTable` (`cvx-kit/webhooks`): raw-body signature verification
  (fail closed), natural-key dedup transactional inside the target internal
  mutation, host-owned dedup table.
- **Agent tool generator** — `createAgentTools` (`cvx-kit/agent-tools`):
  tool records from the table tool masks, shape-compatible with
  `@convex-dev/agent`'s `createTool` without depending on it; mutation
  handlers route through command executors so agents get audited commands.
- **Typed middleware context** — `Command.middleware<Ctx, Extension>` /
  `Query.middleware<Ctx, Extension>`: `next({ context })` is typed against
  the declared extension; registries and operations accept typed middleware
  without casts (`AnyCommandMiddleware`/`AnyQueryMiddleware` variance seam).
- **Upgrade guide** — `docs/upgrading.md` ships in the package: old way →
  new way per feature for consumers on 0.0.x.

### Changed

- `tools.update` / `tools.id` masks now use `jsonSafeZid` instead of `zid`,
  so ids present as plain strings in generated JSON schemas (compile-time
  `Id<...>` types preserved).
- Release workflow now creates a GitHub Release with this file's section as
  notes, and action pins are updated past the Node 20 deprecation.

## [0.0.8] - 2026-08-14

- Composable next()-based middleware for Command and Query kernels, inside
  pipeline invariants (registry-wide + per-operation, context enrichment,
  result re-parse).

## [0.0.7] - 2026-08-14

- `systemQuery` constructor: internal, include-equipped, RLS-unwrapped.
  BREAKING: `createAuthFunctions` config requires the `internalQuery` builder.

## [0.0.6] - 2026-08-14

- Materialized `convex.config.js` bridges (Convex CLI discovers components by
  that literal filename). BREAKING: mount via
  `cvx-kit/components/<name>/convex.config`; client facades no longer
  default-export the component config.

## [0.0.5] - 2026-08-14

- BREAKING: the Foundation facade is the only runtime surface — kernel
  classes and execution utilities destructure from the instance.

## [0.0.4] - 2026-08-14

- Tarball ships only `dist`, `docs`, and the source test helper
  (`.npmignore`); `cvx-kit/test` registers compiled dist modules.

## [0.0.3] - 2026-08-14

- Opt-in tenancy and security controls: `tenantTable`, `createModule`,
  `security` config on `createAuthFunctions` (role rules + tenant RLS),
  `ctx.tenant`, `cvx-kit/tenancy`, `tenantOwnership` trigger. Command
  guards, permission checks, and the aggregate allowlist.

## [0.0.2] - 2026-08-13

- Shipped package documentation (architecture, conventions, migration,
  llms) at `docs/`; opinionated timestamps on every table; single-path
  component mounts.

## [0.0.1] - 2026-08-13

- Initial release: foundation + approvals components, zod-table boundaries,
  auth constructors, triggers, audited command protocol.
