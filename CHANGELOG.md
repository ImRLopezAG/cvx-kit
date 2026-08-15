# Changelog

All notable changes to cvx-kit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**Semver contract (from 0.1.0):** while on 0.x, breaking changes land only on
minor bumps; patches are additive or fixes. The breaking window formally
closes at the follow-up consolidation release (package-name decision + full
export-name API audit) — until then, the six 0.1.0 helper surfaces may still
be renamed in a minor. Every release tag gets a GitHub Release whose notes
are this file's matching section.

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
