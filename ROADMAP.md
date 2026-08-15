# Roadmap to 1.0.0

Where cvx-kit is going and what "stable" will mean. Tracked with checkboxes;
each milestone ships as one minor version. From `0.1.0` on, **breaking
changes only land on minor bumps** (0.x semver: minor = breaking, patch =
fix/additive) and every release gets a CHANGELOG entry.

## 0.1.0 — the big one: API consolidation + the feature set

Goal: one release that both closes the breaking window AND ships the full
helper surface, so consumers adopt a complete kit once instead of chasing
minors. Everything here may still rename freely — that's why the features
belong in this milestone: they land already conforming to the frozen names.

### Consolidation (the last breaking pass)

- [ ] Decide the published name (`cvx-kit` is a working title) and, if it
      changes, publish under the final name with `cvx-kit` deprecated.
- [ ] API audit: review every exported name, option key, and error code
      against `conventions.md`'s own naming grammar; freeze the error-code
      taxonomy (`KitError` codes) as a documented tuple.
- [x] Typed middleware context accumulation: `next({ context })` currently
      merges loosely; tighten so enrichment widens the downstream ctx type
      (TanStack-style), without breaking the loose form.
- [x] Introduce `CHANGELOG.md` + release notes on the GitHub tag; adopt the
      0.x semver contract above. (GitHub Releases automated in release.yml.)
- [ ] CI hardening: add `--dry-run` pack + `attw` (Are The Types Wrong) next
      to publint; bump the deprecated actions pins.

### Features

- [x] **Pagination bridge** — `paginated(table.publicDto)` arg/return
      helpers over Convex's pagination validators, and an
      `include(...).paginate(opts)` terminal next to `.execute(limit)`:
      cursors, not just bounded `take`.
- [x] **CRUD command factory** — `createCrudCommands(table, policy)`
      generating the standard create/update/archive operations from a
      zodTable's masks: command input from `commandFields`, audit derivation
      from the aggregate, timestamps/tenant already structural. The single
      biggest remaining per-entity boilerplate.
- [x] **State-machine helper** — `createStateMachine(STATES, transitions)`
      typed against the constants tuple, returning `isTransitionLegal` /
      `assertTransition` that drop straight into a command `guard`.
- [x] **Rate-limit middleware factory** — the first official middleware:
      `rateLimit({ key: (ctx) => ctx.tenant, ... })` over
      `@convex-dev/rate-limiter`, packaged as `Command.middleware` /
      `Query.middleware` and the template for future middleware.
- [x] **Webhook boundary helper** — signature verification + event dedup by
      natural key (`${event}:${id}:${updatedAt}`) + delegation to a
      `system*` function: the one boundary that genuinely needs dedup, as a
      first-class helper.
- [x] **Agent tool generator** — `createAgentTools(table, executors)`
      emitting `@convex-dev/agent` tool definitions from the existing
      `tools.*` masks + `jsonSafeZid`, with handlers routed through the
      command protocol — agents get audited commands, never raw db access.

Each feature ships with its own doc page (or section), tests on the real
Convex runtime where applicable, and an `llms.md` entry.

## 0.2.0 — guardrails as a product

Goal: the conventions the docs prescribe become importable tests, so a
consumer gets the origin app's discipline on day one — enforced against the
by-then-frozen 0.1.0 names.

- [ ] `createArchitectureTest(rules)` — glob-based rule runner with the
      standard rules built in (no raw builders outside functions.ts, no
      inline tables/enums, no sibling-domain imports, no deep component
      imports, facades mount once), each rule fixture-proved, extensible
      with app-specific rules.
- [ ] Tenancy exhaustiveness helper: assert every `tenantTable` is in the
      registry and vice versa; assert internal builders accept no tenant arg.
- [ ] `llms.md` conformance check: an automated test that every export in
      its tables exists with that signature (also an rc gate — build it here).
- [ ] Port the approvals copyability test (cp -r + tsc) into this repo's
      suite as the permanent portability guarantee for both components.

## 0.3.0 — scaffolding

Goal: the first hour of a new app is generated, not hand-written.

- [ ] WorkOS scaffold generator: `auth.ts`, `auth.config.ts`, `http.ts`,
      `functions.ts`, `foundation.ts`, `triggers.ts` from one command.
- [ ] Audit facade helpers over any `convex-audit-log` instance:
      fingerprinted cursors, bounded windows, admin readers.
- [ ] Decide on the optional idempotency/replay component (deferred from
      0.0.x — only if a consumer demonstrates the need beyond Convex's
      exactly-once mutation delivery).

## 1.0.0-rc — proving it

Entry gates, not work items. The rc ships when all are true:

- [ ] Two real applications run the latest kit in production-like use for
      several weeks (the multi-tenant integration and one more).
- [ ] One full minor cycle with zero breaking changes needed.
- [ ] Docs complete and verified: the `llms.md` conformance check (built in
      0.2.0) green in CI.
- [ ] CI matrix: bun + node LTS, convex peer-range min and latest.
- [ ] Public-API test coverage: every exported runtime symbol exercised by
      at least one test.

## 1.0.0

- [ ] Freeze the export surface; document the semver contract (what counts
      as breaking, deprecation policy of one minor with warnings).
- [ ] `MIGRATING.md` from 0.x.
- [ ] Provenance, README badges, and a docs site or expanded README landing.

## Candidates (recorded, not committed)

- Observability sink adapters: OTel/Axiom-shaped formatters for the
  injectable `emit`, so `command.execution` events land in real telemetry
  without per-consumer mapping.
- Migration companion: a thin `@convex-dev/migrations` wrapper aligned with
  zodTable epochs ("make optional field required after backfill" as a
  declared step), closing the loop with `migration.md`.

## Explicitly out of scope for 1.0

- General idempotency store (platform already covers single-call
  exactly-once; boundary dedup is the webhook helper's job).
- Frontend helpers/React bindings.
- Multi-provider auth abstractions beyond the injected-policy seam
  (`createAuthFunctions` already accepts any provider via `getAuthUser`/
  `mapRole`/`verifyMembership`).
