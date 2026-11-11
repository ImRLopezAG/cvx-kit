# Module-load benchmark

These are local bundled-import measurements, not deployed Convex latency. No database, provider or handler runs. The timer includes loading/evaluating the bundle and its consumer declarations, excluding process startup, bundling and output verification.

## Workloads

- **Deferred** (`scripts/bench/module-load-entry.ts`): the existing 87-table fixture, 30 scalar-pagination/relation-page contract pairs on tasks, and 20 Effect registries. Registry identities and handlers are not forced. Object contracts construct their schemas at declaration; thunk contracts defer them.
- **Eager consumer** (`scripts/bench/eager-module-load-entry.ts`): the same 87 indexed tables (84 generated domains, tasks, payments and notes), with command fields enabled for the generated domains. Reads ordinary document IDs across tables, extends each domain's public DTO, refines command inputs, reads update/tool schemas, builds a native `defineSchema(createModule(...))` map and registers all tables/edges. Thirty *distinct* domain contracts call scalar `paginationOpts` and relation `pageDto` at module scope. API-style reads consume every contract, including thunks. This exercises more derived reads than the reported Accord module; it is a synthetic eager consumer, not an Accord reproduction.

The eager case matters: repeating one table's page helper benefits from its recipe cache and misses first-use composition cost across domains. Earlier sparse/same-table probes did not reproduce the net regression. The distinct-domain baseline did: 0.1.26 was slower than 0.1.25 in both Node modes. The first constructor-only candidate also remained slower; the retained solution additionally removes first-page reconstruction for unselected ordinary rows under the existing audited constructor environment.

## Local results

Recorded 2026-11-02: macOS, Node v26.13.0, Zod 4.6.5, Convex 1.48.0, convex-helpers 0.1.129, identical installed dependencies and esbuild settings. Sources: 0.1.25 `6cbbb1532a7f29de7efa17cd6888b92184e735ca`; 0.1.26 `bbee6e2027ad8b1521bc15279db497d95d5ca058`; corrected 0.1.27 runtime source `fd759091aa2d967459010b9a800b39c805060385` (after the variant-isolation review fix). All sources receive byte-identical fixture files before bundling. Bundler conditions are `convex,module`; platform is browser, format ESM, with syntax/identifier minification and retained names, matching the existing Convex-oriented harness.

Each cell is **median [p25, p75]** milliseconds from 21 fresh-process imports per case. The starting case rotates each round; every round measures every version/form/workload. No warmup samples or outliers are removed. Phase medians are independent and need not sum to load medians. Full min/max and all samples are retained in the JSON receipts.

### Ordinary Node (JIT enabled)

| Version/form | Deferred import | Eager import |
| --- | ---: | ---: |
| 0.1.25 object | 49.80 [49.69, 50.11] | 56.50 [56.25, 56.87] |
| 0.1.26 object | 42.08 [41.82, 42.40] | 64.99 [64.46, 65.61] |
| 0.1.26 thunk | 25.78 [25.74, 26.06] | 65.08 [64.62, 65.44] |
| 0.1.27 object | 41.76 [41.56, 42.06] | 56.50 [56.08, 57.09] |
| 0.1.27 thunk | 25.13 [25.00, 25.24] | 56.40 [56.28, 56.66] |

### Node --jitless

| Version/form | Deferred import | Eager import |
| --- | ---: | ---: |
| 0.1.25 object | 64.99 [64.77, 65.22] | 80.17 [79.54, 80.37] |
| 0.1.26 object | 52.36 [51.93, 52.58] | 90.15 [89.37, 90.42] |
| 0.1.26 thunk | 28.96 [28.80, 29.04] | 90.00 [89.60, 90.28] |
| 0.1.27 object | 51.66 [51.42, 51.91] | 78.86 [78.51, 79.42] |
| 0.1.27 thunk | 27.99 [27.86, 28.15] | 78.95 [78.60, 79.63] |

0.1.25 has no thunk API. Candidate eager object/thunk medians are at or below the 0.1.25 object reference in both modes, with overlapping distributions. The eager JIT object medians differ by less than 0.001 ms, so this is effectively neutral, not evidence of a speedup. The deferred fixture retains the large improvement over 0.1.25; tiny differences from 0.1.26 are within the observed spread. These data do not establish a statistically separated speedup, unbundled package performance, minimum-peer performance, or deployed acceptance.

The harness compares each eager bundle's complete snapshot with the 0.1.25 snapshot after its first timed import: native table/index serialization, all composed domain/tool schema descriptions, valid DTO/command/update/tool/reference outputs, thirty nonempty page/input outputs, and invalid input/output rejection. Zod custom IDs are opaque in JSON Schema (`unrepresentable: 'any'`), so reference parsing, native serialization and existing branded-ID/type tests provide complementary coverage. Later samples measure import only; output checks never enter the timer. Deferred snapshots are intentionally not forced, preserving that workload.

### Costs and retained semantics

Direct strict constructors remove intermediate object clones. Private write/command field selections are reused, but each public schema owns its field map: changing `insertSchema.shape`, storage or command shapes cannot change independent update/document/tool boundaries. Scalar pagination still converts the current mutable document shape on every call.

Relation pages build only result validators. For ordinary rows without selected relations or field groups, the first page is a fresh graph built from independently restored private recipes; the registry captures its immutable recipe before returning it. Reusing that first graph requires the existing audited Zod version/config/memoizer guard before and after construction. Variant rows, composed relations, field groups and other constructor environments reconstruct it, preserving independent mutable validators across variant branches. Later calls always reconstruct independent public validators. This does not change registration/native ownership checks, projection rules or the public `paginated()` args/result surface. Memoized getters and thunk Proxy semantics remain unchanged.

## Per-request app benchmark

Convex evaluates a function's whole static import graph on every request, and module state never survives to the next request. So what counts is the cost of importing one function module, plus building what a single invocation needs. Recipe caches that only pay off on a second call do not count.

`scripts/bench/app-module-load-entry.ts` is one function module of a representative app (`scripts/bench/app-fixture.ts`):

- 28 table boundaries plus two variant tables.
- Relations with parent and owner joins and variant-branch edges.
- Three thunk domain contracts, each with nine commands, two detail queries and three relation-pagination list queries (compact validators with variant selections, relation `pageDto`).
- `createAuthFunctions` with a trigger registry.

The module registers all 14 operations of one contract through `authMutation`/`authQuery`. The other two contracts are imported but never read. Native table definitions (indexes) sit behind `appSchemaTables`, which only a schema module would import.

Two variants are measured:

- **eager**: today's consumer form, `args: contract.commands.x.input`.
- **getter**: `get args()` / `get returns()` plus getter-declared contract operations.

`node scripts/bench-app-load.mjs [--runs N] [--source label=root ...] [--check scripts/bench/app-load-budget.json]` bundles the entry like Convex (browser, ESM, `convex,module` conditions) and imports it in fresh `--expose-gc` processes, rotating the starting case each round. It reports these medians:

- `load`: import time.
- `retainedMB`: retained heap after GC.
- `invoke`: building one function's pushed validators.
- The module's own phase timings.

Pushed `exportArgs`/`exportReturns` JSON must be identical across every source and variant, or the run fails. A `--source` root only needs a `src/` tree with `node_modules` resolvable from it. `bun run bench:app-load` checks the candidate against the budget file.

`node scripts/bench-consumer.mjs <convex-dir> <entry.ts ...> [--installed]` measures a consumer's real entries. It redirects `cvx-kit/*` to this checkout's `dist` through the export map, and resolves the dist's own dependencies from the consumer's installed copy, so the consumer's `node_modules` is never modified.

### Baseline (2026-11-11, before the per-request changes)

macOS, Node v26.13.0, source `1d47ecf` (0.1.29 runtime), 15 rounds, JIT enabled.

| Variant | load ms | retained MB | invoke ms | registration ms |
| --- | ---: | ---: | ---: | ---: |
| eager | 43.14 | 10.24 | 2.62 | 19.56 |
| getter | 48.94 | 10.32 | 2.64 | 25.00 |

Accord (`feat/enrollment-intake-v2` checkout, unchanged source), esbuild bundles, 9 runs:

| Entry | cvx-kit | bundle KB | load ms | retained MB |
| --- | --- | ---: | ---: | ---: |
| `api/payments` | installed 0.1.29 | 3901 | 163.3 | 29.1 |
| `api/payments` | local dist (`1d47ecf`) | 3902 | 161.3 | 29.1 |
| `api/search` | installed 0.1.29 | 2623 | 90.0 | 9.7 |
| `api/search` | local dist (`1d47ecf`) | 2625 | 94.5 | 9.7 |

With `bun build --target=browser`, the same entries evaluate in 131 ms / 28.2 MB (`api/payments`) and ~76 ms / 9.0 MB (`api/search`). The deployed dev p50 for those functions is ~600 ms and ~280 ms.

## Reproduce

Install the checkout's locked dependencies first (`bun install --frozen-lockfile`). Prepare source-only archives outside the checkout; do not use another application's checkout:

```sh
proof=/tmp/cvx-module-load-reproduction
mkdir -p "$proof/0.1.25" "$proof/0.1.26"
git archive 6cbbb1532a7f29de7efa17cd6888b92184e735ca | tar -x -C "$proof/0.1.25"
git archive bbee6e2027ad8b1521bc15279db497d95d5ca058 | tar -x -C "$proof/0.1.26"
for version in 0.1.25 0.1.26; do
  ln -s "$PWD/node_modules" "$proof/$version/node_modules"
  cp scripts/bench/{relations-fixture,module-load-entry,eager-module-load-entry}.ts "$proof/$version/scripts/bench/"
done
node scripts/bench-module-load.mjs "$proof/jitless" 21 "0.1.25=$proof/0.1.25" "0.1.26=$proof/0.1.26" candidate=.
node scripts/bench-module-load.mjs "$proof/jit" 21 --jit "0.1.25=$proof/0.1.25" "0.1.26=$proof/0.1.26" candidate=.
```

Each run writes `results.json` (all samples, phase distributions, Node mode and source roots) and `output.json` (the checked eager snapshot). Run the two commands sequentially, without concurrent builds/tests/benchmarks. Existing single-source commands remain available: `node scripts/bench-relations.mjs . 11 module-load [lazy-contracts]`.

This implementation's retained evidence is under `/tmp/cvx-eager-proof`: `RED-distinct-consumer.log`, `distinct-baseline/`, intermediate phase logs, `corrected-jit/`, `corrected-jitless/`, full verification logs and `receipt.json`. Earlier `final-jit/` and `final-jitless/` receipts precede the review fix and are superseded by these corrected measurements. The baseline timing RED precedes the page optimization; runtime characterization precedes production changes. The corrected source passes 2,556 tests across 96 files, build/publint, project types, lint, package contents and 608 integration tests. Packed querying passes current/minimum peers (including full stress and focused runtime); packed variants and npm/Bun Effect consumers pass. Independent Astra Low source recheck closed the variant-isolation finding. Review, test and package receipts are retained alongside the benchmark results. Deployed Accord acceptance remains consumer-owned.
