# Module-load benchmark

These are local bundled-import measurements, not deployed Convex latency. No database, provider or handler runs. The timer includes loading/evaluating the bundle and its consumer declarations, excluding process startup, bundling and output verification.

## Workloads

- **Deferred** (`scripts/bench/module-load-entry.ts`): the existing 87-table fixture, 30 scalar-pagination/relation-page contract pairs on tasks, and 20 Effect registries. Registry identities and handlers are not forced. Object contracts construct their schemas at declaration; thunk contracts defer them.
- **Eager consumer** (`scripts/bench/eager-module-load-entry.ts`): the same 87 indexed tables (84 generated domains, tasks, payments and notes), with command fields enabled for the generated domains. Reads ordinary document IDs across tables, extends each domain's public DTO, refines command inputs, reads update/tool schemas, builds a native `defineSchema(createModule(...))` map and registers all tables/edges. Thirty *distinct* domain contracts call scalar `paginationOpts` and relation `pageDto` at module scope. API-style reads consume every contract, including thunks. This exercises more derived reads than the reported Accord module; it is a synthetic eager consumer, not an Accord reproduction.

The eager case matters: repeating one table's page helper benefits from its recipe cache and misses first-use composition cost across domains. Earlier sparse/same-table probes did not reproduce the net regression. The distinct-domain baseline did: 0.1.26 was slower than 0.1.25 in both Node modes. The first constructor-only candidate also remained slower; the retained solution additionally removes first-page reconstruction under the existing audited constructor environment.

## Local results

Recorded 2026-11-02: macOS, Node v26.13.0, Zod 4.6.5, Convex 1.48.0, convex-helpers 0.1.129, identical installed dependencies and esbuild settings. Sources: 0.1.25 `6cbbb1532a7f29de7efa17cd6888b92184e735ca`; 0.1.26 `bbee6e2027ad8b1521bc15279db497d95d5ca058`; candidate 0.1.27 source on this branch. All sources receive byte-identical fixture files before bundling. Bundler conditions are `convex,module`; platform is browser, format ESM, with syntax/identifier minification and retained names, matching the existing Convex-oriented harness.

Each cell is **median [p25, p75]** milliseconds from 21 fresh-process imports per case. The starting case rotates each round; every round measures every version/form/workload. No warmup samples or outliers are removed. Phase medians are independent and need not sum to load medians. Full min/max and all samples are retained in the JSON receipts.

### Ordinary Node (JIT enabled)

| Version/form | Deferred import | Eager import |
| --- | ---: | ---: |
| 0.1.25 object | 48.56 [48.38, 48.77] | 55.35 [55.13, 55.53] |
| 0.1.26 object | 40.65 [40.56, 40.94] | 63.83 [63.22, 64.26] |
| 0.1.26 thunk | 24.53 [24.37, 24.74] | 64.11 [63.70, 64.67] |
| 0.1.27 object | 40.73 [40.24, 41.57] | 55.05 [54.82, 55.50] |
| 0.1.27 thunk | 24.23 [24.05, 24.54] | 55.21 [54.98, 55.80] |

### Node --jitless

| Version/form | Deferred import | Eager import |
| --- | ---: | ---: |
| 0.1.25 object | 62.20 [62.00, 62.57] | 76.96 [76.37, 77.14] |
| 0.1.26 object | 49.65 [49.30, 50.18] | 86.74 [86.53, 87.85] |
| 0.1.26 thunk | 27.20 [27.07, 27.34] | 86.73 [86.59, 87.47] |
| 0.1.27 object | 49.14 [48.91, 49.32] | 75.94 [75.47, 76.49] |
| 0.1.27 thunk | 26.28 [26.18, 26.53] | 76.05 [75.59, 76.50] |

0.1.25 has no thunk API. Candidate eager object/thunk medians are at or below the 0.1.25 object reference in both modes, with a small margin and overlapping distributions. The deferred fixture retains the large improvement over 0.1.25; tiny differences from 0.1.26 are within the observed spread. These data do not establish a statistically separated speedup, unbundled package performance, minimum-peer performance, or deployed acceptance.

The harness compares each eager bundle's complete snapshot with the 0.1.25 snapshot after its first timed import: native table/index serialization, all composed domain/tool schema descriptions, valid DTO/command/update/tool/reference outputs, thirty nonempty page/input outputs, and invalid input/output rejection. Zod custom IDs are opaque in JSON Schema (`unrepresentable: 'any'`), so reference parsing, native serialization and existing branded-ID/type tests provide complementary coverage. Later samples measure import only; output checks never enter the timer. Deferred snapshots are intentionally not forced, preserving that workload.

### Costs and retained semantics

Direct strict constructors remove intermediate object clones. Private write/command field selections are reused, but each public schema owns its field map: changing `insertSchema.shape`, storage or command shapes cannot change independent update/document/tool boundaries. Scalar pagination still converts the current mutable document shape on every call.

Relation pages build only result validators. The first page is already a fresh graph built from private recipes; the registry captures its immutable recipe before returning it. Reusing that first graph requires the existing audited Zod version/config/memoizer guard before and after construction. Other environments reconstruct it. Later calls always reconstruct independent public validators. This does not change registration/native ownership checks, projection rules or the public `paginated()` args/result surface. Memoized getters and thunk Proxy semantics remain unchanged.

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

This implementation's retained evidence is under `/tmp/cvx-eager-proof`: `RED-distinct-consumer.log`, `distinct-baseline/`, intermediate phase logs, `final-jit/`, `final-jitless/`, full verification logs and `receipt.json`. The baseline timing RED precedes the page optimization; runtime characterization precedes production changes. The parent owns packed consumer matrix checks, independent review and release.
