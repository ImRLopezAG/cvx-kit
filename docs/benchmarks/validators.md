# cvx-kit 2 benchmark record

v1 is cvx-kit 0.1.35 (Zod, commit `8d979a5`). v2 is this tree (`k`, `kTable`, `kVariantTable`, no Zod in the core).

## Summary: the full representative app

The app has 30 table boundaries (28 entity tables and two variant tables), relations with 34 joins, three thunk domain contracts with compact relation pagination over the variant tables, and auth builders with triggers and tenancy; one function module registers the 14 operations of one contract.
Figures are for the `eager` variant (`args` and `returns` declared as properties); the `getter` variant is in the full tables below.

| metric                                                     |      v1 |      v2 | change |
| ---------------------------------------------------------- | ------: | ------: | -----: |
| bundle KB                                                  |   815.8 |   220.6 | -73.0% |
| Zod KB in bundle                                           |   582.1 |     0.0 |  -100% |
| module load ms                                             |   28.34 |    7.97 | -71.9% |
| retained heap MB                                           |    9.37 |    2.03 | -78.3% |
| first validator build for one function (`listPayments`) ms |    3.10 |    3.46 | +11.8% |
| first call ms (whole request without relations, `create`)  |    1.60 |    0.85 | -47.0% |
| tsc instantiations (fixture and the kit source it imports) | 804,286 | 259,983 | -67.7% |

The first-call row comes from the smaller request fixture in section (d), because the full app's harness builds validators but does not call a function.

## Rerun after merging 0.2.0

v2 now includes the 0.2.0 changes (convex 1.51.0, zod 4.6.7, convex-helpers 0.1.137, cursor and relation-page reuse, `argumentFailure`). The tables below rerun the two app benches on those versions, against 0.1.35 and against the 0.2.0 release commit (`f191ff3`, selected with `CVX_BENCH_V1_REF`). The rest of this document was recorded before the merge, on zod 4.6.5 and convex 1.48.0, and is kept as recorded; the schema-layer and spike sections were not rerun.

Full app, `eager` variant, medians of 15:

| metric             | 0.1.35 | 0.2.0 |    v2 | v2 vs 0.2.0 |
| ------------------ | -----: | ----: | ----: | ----------: |
| bundle KB          |  823.8 | 829.3 | 230.3 |      -72.2% |
| Zod KB in bundle   |  583.3 | 583.4 |   0.0 |       -100% |
| module load ms     |  35.14 | 26.18 |  8.43 |      -67.8% |
| retained heap MB   |   9.38 |  7.40 |  2.05 |      -72.2% |
| registration ms    |  14.05 |  7.01 |  2.58 |      -63.2% |
| tsc instantiations | 813,284 | 854,288 | 254,719 |   -70.2% |

The 0.1.35 and 0.2.0 columns come from two separate runs, each with its own v2 measurement (9.23 ms and 8.43 ms load); the v2 column is the 0.2.0 run. Load times in the 0.1.35 run were higher than in the original record (28.34 ms there), so compare within a run, not across runs.

Whole request without relations, against 0.2.0, medians of 15:

| metric           | 0.2.0 |    v2 | change |
| ---------------- | ----: | ----: | -----: |
| bundle KB        | 763.5 | 190.5 | -75.0% |
| module load ms   | 32.54 |  8.68 | -73.3% |
| retained heap MB |  4.33 |  1.01 | -76.6% |
| first call ms    |  3.07 |  1.65 | -46.1% |
| warm call µs     |  63.4 |  51.4 | -18.8% |

Pushed `exportArgs()` and `exportReturns()` JSON is identical between 0.2.0 and v2 for every function in both fixtures.

The `cvx-kit/zod` interop entry is now built on `zod/mini`. A module that imports `k` and `cvx-kit/zod` bundled to 231.8 KB (153.4 KB of it Zod); built on classic Zod it was 815.4 KB (733.7 KB of Zod). Of the 153 KB, about 85 KB was classic code that convex-helpers' `zid` imports. Ids now convert to an own `zod/mini` schema, and the same module bundles to 152.2 KB (72.7 KB of Zod, no classic Zod and no convex-helpers); measured in the same session, the `zid` build was 237.4 KB (157.1 KB of Zod).

## How it is measured

- Every case is bundled the way Convex does: esbuild, browser platform, ESM, `convex,module` conditions, syntax and identifier minification, names kept, `process.env.NODE_ENV` set to `"production"`.
- Each sample imports the bundle in a fresh `node --expose-gc` process. Load ms is the time of the dynamic `import`. Retained MB is heap after a forced GC minus heap before the import. Medians of 15 rounds; the starting case rotates each round.
- v1 is not in this tree. The benches extract `git archive 8d979a5 src scripts/bench` into a temp directory and bundle the v1 fixture against that tree (`scripts/bench/v1-source.mjs`). Both sides resolve `zod` 4.6.5, `convex` 1.48.0 and `convex-helpers` 0.1.129 from this checkout's `node_modules`. In a shallow clone the v1 rows are skipped with a note.
- Before measuring, each bench checks that v1 and v2 push byte-identical `exportArgs()` and `exportReturns()` JSON for every function.
- Machine: Apple M5, darwin arm64, node v26.13.1, TypeScript 7.0.2.

Commands:

```text
node scripts/bench-app-load.mjs --runs 15 --types
node scripts/bench-request.mjs --runs 15
node scripts/bench-validators.mjs --runs 15
node scripts/bench-validators.mjs --runs 15 --descriptor <path outside the repo>
```

`bun run bench:app-load` measures v2 only and checks the medians against `scripts/bench/app-load-budget.json` (about 25% above the medians below for load and retained heap, about 10% for bundle size), so CI needs no git history.

## Full app (`scripts/bench-app-load.mjs`)

The v2 app is `scripts/bench/app-fixture.ts` with its entry `scripts/bench/app-module-load-entry.ts`; the v1 app is the same two files at `8d979a5`.
The translation is field for field: `z.object` and `z.strictObject` become `k.object`, `zid` becomes `k.id`, `zodTable` and `zodVariantTable` become `kTable` and `kVariantTable`, and Zod's `.pick({ filters: true, order: true })` becomes `.pick('filters', 'order')`.

Phases: `tables` declares the 30 boundaries, `defineRelations` registers the joins, `contractsAndAuth` declares three domain contracts and the auth builders, `registration` registers the 14 functions. `invoke` reads `exportArgs()` and `exportReturns()` of `listPayments`, which builds its validators on first read.

| case      | functions | bundle KB | zod KB | load ms | retained MB | tables ms | defineRelations ms | contractsAndAuth ms | registration ms | invoke ms |
| --------- | --------: | --------: | -----: | ------: | ----------: | --------: | -----------------: | ------------------: | --------------: | --------: |
| v1-eager  |        14 |     815.8 |  582.1 |   28.34 |        9.37 |      3.76 |               1.59 |                0.26 |           10.28 |      3.10 |
| v1-getter |        14 |     815.9 |  582.1 |   18.46 |        6.41 |      3.76 |               1.61 |                0.28 |            0.25 |      8.21 |
| v2-eager  |        14 |     220.6 |    0.0 |    7.97 |        2.03 |      0.72 |               1.20 |                0.27 |            2.80 |      3.46 |
| v2-getter |        14 |     220.7 |    0.0 |    5.66 |        1.71 |      0.71 |               1.21 |                0.27 |            0.49 |      5.00 |

Bytes in the bundle by owner:

| bytes          | v1-eager | v1-getter | v2-eager | v2-getter |
| -------------- | -------: | --------: | -------: | --------: |
| zod            |   596021 |    596021 |        0 |         0 |
| convex         |    73158 |     73158 |    72983 |     72983 |
| convex-helpers |    16579 |     16579 |    15162 |     15162 |
| cvx-kit        |   124794 |    124794 |   128181 |    128181 |
| fixture        |     6515 |      6615 |     6565 |      6665 |
| (glue)         |    18337 |     18337 |     3037 |      3037 |
| total          |   835404 |    835504 |   225928 |    226028 |

```text
v2-eager vs v1-eager: load ms -71.9%, retained MB -78.3%, bundle KB -73.0%, invoke ms 11.8%
v2-getter vs v1-getter: load ms -69.3%, retained MB -73.3%, bundle KB -72.9%, invoke ms -39.1%
```

Export parity: `exportArgs()`/`exportReturns()` JSON of all 14 functions is identical across v1-eager, v1-getter, v2-eager and v2-getter. No normalisation was applied; the fixture declares no `tools.*` ids and no `.optional().default()` field, the two documented v1 to v2 validator differences.

### Type cost

`--types` runs `tsc --extendedDiagnostics` (strict, bundler resolution, `skipLibCheck`) on each side's entry. The kit is imported as source on both sides, so the figures include checking the kit's own files.

| types | files |  Types | Instantiations | Check ms |
| ----- | ----: | -----: | -------------: | -------: |
| v1    |   372 | 301869 |         804286 |      243 |
| v2    |   284 | 102488 |         259983 |       79 |

Both sides typecheck with zero errors. The v1 fixture at `8d979a5` was only ever bundled and has three type errors: in `appSchemaTables` a union of `.index` overloads is not callable, and the `{ ...entities, payments, ledger }` spread in `defineAppTables` drops the generated index signature, so `tables[domain]` is untyped. For `--types` only, the bench applies to the extracted v1 copy the two edits the v2 fixture carries (`v1TypePatches` in the script): `Object.assign(entities, { payments, ledger })`, and `appSchemaTables` indexing the variant tables by name. The entry never calls `appSchemaTables`, and the runtime figures use the unedited v1 fixture.

## Whole request without relations (`scripts/bench-request.mjs`)

The fixtures in `scripts/bench/request/` declare the 30 table boundaries and the auth builders of the app above, without relations or contracts, and register five operations of one domain through `authMutation` and `authQuery`: `create`, `update`, `get`, `list` and `archive`.
Export ms is `exportArgs()` plus `exportReturns()` on all five functions, the deploy-analysis path.
First-call and warm-call time is `create` invoked through Convex's `invokeMutation` hook with JSON args and a stubbed identity syscall; warm is the mean of 200 further calls.
The bench also checks that both sides return the same results for valid calls and reject a `create` whose title fails `min(1)`.

| case      | bundle KB | zod KB | load ms | retained MB | tables ms | auth ms | registration ms | export ms | first-call ms | warm-call µs |
| --------- | --------: | -----: | ------: | ----------: | --------: | ------: | --------------: | --------: | ------------: | -----------: |
| v1 eager  |     752.5 |  581.9 |   15.32 |        4.28 |      4.00 |    0.14 |            0.47 |      0.64 |          1.60 |         28.3 |
| v1 getter |     752.5 |  581.9 |   15.09 |        4.21 |      4.04 |    0.14 |            0.16 |      0.95 |          1.71 |         28.7 |
| v2 eager  |     181.4 |    0.0 |    3.77 |        0.98 |      0.73 |    0.16 |            0.33 |      0.73 |          0.85 |         26.4 |
| v2 getter |     181.4 |    0.0 |    3.58 |        0.96 |      0.73 |    0.16 |            0.17 |      0.88 |          0.86 |         26.0 |

| bytes          | v1 eager | v1 getter | v2 eager | v2 getter |
| -------------- | -------: | --------: | -------: | --------: |
| (glue)         |    18190 |     18190 |     2926 |      2926 |
| convex         |    73128 |     73128 |    72942 |     72942 |
| convex-helpers |    16579 |     16579 |    15162 |     15162 |
| fixture        |     4614 |      4614 |     4609 |      4609 |
| src (rest)     |    62178 |     62178 |    58385 |     58385 |
| src/k          |        0 |         0 |    31742 |     31742 |
| zod            |   595906 |    595906 |        0 |         0 |
| total          |   770595 |    770595 |   185766 |    185766 |

```text
v2 eager vs v1 eager: load ms -75.4%, retained MB -77.1%, bundle KB -75.9%, export ms 14.9%, first call ms -47.0%, warm call -6.8%
v2 getter vs v1 getter: load ms -76.3%, retained MB -77.1%, bundle KB -75.9%, export ms -8.0%, first call ms -49.6%, warm call -9.4%
```

Parity: `exportArgs()`/`exportReturns()` JSON of all five functions, the call results and the rejected invalid call match across the four cases.

## Schema layer: four flavors (`scripts/bench-validators.mjs`)

The same schemas written with classic Zod 4, `zod/mini`, plain Convex `v.*` and `k`, each emitted from a neutral descriptor with one table definition and one function registration per group.

- **declare** is the time and retained heap of importing the module.
- **+native** also builds every native Convex validator, plus a `defineTable` and a query registration per group. Convex needs these at deploy analysis and schema export, not on each call.
- **Types** and **Instantiations** come from `tsc --extendedDiagnostics` on the emitted source.

The `convex` flavor cannot express checks or defaults, so it declares structure only. The Zod flavors and `k` declare the same checks.

### Synthetic workload

400 schemas and 57 table-and-function groups, generated with seed 1 from the call-site mix of two consumer apps. Re-run on the final tree.

| flavor   | bundle KB | zod KB | declare ms | declare MB | +native ms | +native MB |  Types | Instantiations |
| -------- | --------: | -----: | ---------: | ---------: | ---------: | ---------: | -----: | -------------: |
| zod      |     853.1 |  581.9 |      32.78 |      17.19 |      42.95 |      18.30 | 240071 |        2139108 |
| zod-mini |     324.3 |  115.5 |      20.26 |      10.86 |      31.87 |      11.97 | 220446 |        2145139 |
| convex   |     276.5 |    0.0 |       9.94 |       2.49 |      10.39 |       2.58 |  43200 |         296109 |
| k        |     290.4 |    0.0 |       7.36 |       2.40 |      11.82 |       3.68 |  70886 |         373590 |

| bytes          |    zod | zod-mini | convex |      k |
| -------------- | -----: | -------: | -----: | -----: |
| (glue)         |  13542 |    10532 |   9570 |   9766 |
| convex         |  59263 |    59230 |  59055 |  59103 |
| convex-helpers |   4731 |     4731 |      0 |      0 |
| schemas        | 200170 |   139329 | 214521 | 197173 |
| src/k          |      0 |        0 |      0 |  31371 |
| zod            | 595868 |   118257 |      0 |      0 |
| total          | 873574 |   332079 | 283146 | 297413 |

### A real module's schema graph

The schemas a consumer app's finance contracts declare on import, with the tables they reference: 350 schemas and 11 groups.
The descriptor is kept outside this repository because the app is private; it was re-run on the final tree.
Refinements, 39 in that module, have no descriptor form and are left out of every flavor.

| flavor   | bundle KB | zod KB | declare ms | declare MB | +native ms | +native MB |  Types | Instantiations |
| -------- | --------: | -----: | ---------: | ---------: | ---------: | ---------: | -----: | -------------: |
| zod      |     782.4 |  581.9 |      23.44 |      10.56 |      35.92 |      11.93 | 124840 |        1319951 |
| zod-mini |     285.2 |  115.5 |      13.68 |       6.32 |      26.46 |       7.68 | 116772 |        1319919 |
| convex   |     201.3 |    0.0 |       6.24 |       1.54 |       6.57 |       1.57 |  20595 |         194063 |
| k        |     222.7 |    0.0 |       4.78 |       1.61 |       7.98 |       2.26 |  41965 |         241745 |

| bytes          |    zod | zod-mini | convex |      k |
| -------------- | -----: | -------: | -----: | -----: |
| (glue)         |  16410 |    13400 |  12425 |  12624 |
| convex         |  59325 |    59281 |  59132 |  59154 |
| convex-helpers |   4731 |     4731 |      0 |      0 |
| schemas        | 124774 |    96340 | 134572 | 124815 |
| src/k          |      0 |        0 |      0 |  31425 |
| zod            | 595913 |   118261 |      0 |      0 |
| total          | 801153 |   292013 | 206129 | 228018 |

`zod/mini` still carries 115 KB of Zod because the Convex id helper imports classic Zod.

## Spike gate (as recorded at the prototype stage)

The plan allowed v2 to proceed only if none of four stop conditions held. Measured on the real module's graph with the prototype `k` (which was 4.7 KB of the bundle):

| Stop condition                                  | Threshold                            | Measured                                                                  | Holds |
| ----------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- | ----- |
| Module eval gain against classic Zod too small  | less than 50% lower                  | 81.6% lower (23.05 ms to 4.24 ms)                                         | no    |
| `k` not clearly better than the `zod/mini` gain | within 10 points                     | `zod/mini` 42.2%, `k` 81.6%                                               | no    |
| `k` costs too much over plain `v.*`             | more than 15% slower                 | 30% faster to declare; 12.6% slower when every native validator is forced | no    |
| Type cost regresses                             | more instantiations than classic Zod | 220,395 against 1,319,951                                                 | no    |

The same conditions on the final `k` (table above): 79.6% lower than classic Zod (23.44 ms to 4.78 ms); `zod/mini` 41.6% against `k` 79.6%; 23.4% faster than `v.*` to declare and 21.5% slower when every native validator is forced; 241,745 instantiations against 1,319,951.

## What did not improve or got worse

- The finished `k` is larger and slower than the prototype the gate passed on. On the real module's graph, `k`'s own code grew from 4.7 KB to 31,425 bytes of the bundle, declare time from 4.24 ms to 4.78 ms, forced-native time from 7.23 ms to 7.98 ms and instantiations from 220,395 to 241,745. On the synthetic workload the `k` bundle went from 264.3 KB to 290.4 KB, which is now 13.9 KB more than plain `v.*` (276.5 KB).
- With every native validator forced, `k` is 13.8% slower than plain `v.*` on the synthetic workload (11.82 ms against 10.39 ms) and 21.5% slower on the real module's graph (7.98 ms against 6.57 ms). The second figure is above the gate's 15% threshold; the gate was decided on declare time, where `k` is faster than `v.*` (4.78 ms against 6.24 ms).
- Building validators on first read is not faster. In the full app, building `listPayments`'s validators takes 3.46 ms against 3.10 ms in v1 (+11.8%, eager). In the request fixture, exporting all five functions' validators takes 0.73 ms against 0.64 ms (+14.9%, eager) and 0.88 ms against 0.95 ms (-8.0%, getter).
- Registration in the getter variant of the full app takes 0.49 ms against 0.25 ms in v1. Both are under half a millisecond; in the eager variant registration is 2.80 ms against 10.28 ms.
- `contractsAndAuth` is unchanged (0.27 ms against 0.26 ms eager), and auth construction in the request fixture is 0.16 ms against 0.14 ms.
- The warm call is 6.8% (eager) to 9.4% (getter) faster; a call spends most of its time in the auth and row-level-security wrappers, and in production Convex checks argument structure outside the isolate.
- The kit's own code is not smaller. cvx-kit contributes 128,181 bytes to the v2 app bundle against 124,794 in v1 (+2.7%); the bundle shrinks because Zod (596,021 bytes), its ESM glue and part of `convex-helpers` leave it.

`defineRelations`, which an earlier run of this record listed as slower, is now faster than v1 (1.20 ms against 1.59 ms eager, -24.5%), since variant common fields and field references are computed on first read.

## Limits of the measurement

- Local machine (Apple M5), not a deployed Convex isolate. The earlier observation is that a deployed isolate takes roughly four times the local figure.
- The app is synthetic: generated tables and contracts shaped like a consumer app, not a consumer app.
- Medians of 15 fresh-process rounds; sub-millisecond phases are close to timer and scheduling noise.
- Type figures check the kit as source on both sides, so they include the kit's own files, which a consumer would read as declaration files under `skipLibCheck`.
- The consumer-app figures that motivated this work (175–250 ms and 24–40 MB per API module) were measured on a real app that has not been migrated to v2, so the gain on a real app is not yet measured.
- The 0.1.x per-request figures, before v2, are in `docs/benchmarks/module-load.md`.

## After the import-cost pass

Measured in one session (`node scripts/bench-app-load.mjs --no-v1 --source before=<daead3c src> --source after=<this checkout>`), medians of 15 fresh processes:

| case | bundle KB | cvx-kit KB | load ms | retained MB | defineRelations ms | registration ms |
|---|---:|---:|---:|---:|---:|---:|
| before, eager | 231.6 | 135.8 | 8.37 | 2.06 | 1.24 | 2.51 |
| before, getter | 231.7 | 135.8 | 6.06 | 1.75 | 1.23 | 0.28 |
| after, eager | 229.6 | 134.9 | 8.26 | 2.05 | 1.22 | 2.52 |
| after, getter | 229.7 | 134.9 | 6.10 | 1.74 | 1.22 | 0.48 |

The bundle shrinks by 2.0 KB (0.8 KB of kit code, 1.2 KB of module glue); the load-time differences are within run-to-run noise. The gain a consumer gets from this pass is the getter form for `args` and `returns` (8.37 ms to 6.06 ms here), now the documented default and what the codemod writes. The `cvx-kit/zod` interop entry drops convex-helpers' `zid` and classic Zod: `k` plus the entry bundles to 152.2 KB, down from 237.4 KB.

Kit bytes (esbuild `bytesInOutput` under `src/`, same options as the bench) for minimal function modules, before and after:

| entry | before KB | after KB |
|---|---:|---:|
| `k` and `kTable`, two tables | 49.8 | 49.8 |
| plus one `createAuthFunctions` query | 91.1 | 90.3 |
| plus relations and a paginated query | 127.5 | 126.7 |
| benchmark app module | 135.7 | 134.9 |

Most of the kit code in the app module is used by it: `relations.ts` (34.9 KB), `k/parse.ts` (15.5 KB), `table.ts` (15.2 KB, which includes table-level `paginationOpts`), auth, managed query security and registration. Their module-level state is already built on first use (`once`/`memoize`), and `sideEffects` already lets unused entries drop. The only module-level values that defeated tree-shaking were the two built-in error contracts, now marked pure.

Relations were already per-table lazy: defining the app's relations reads each referenced table's `k` schema for its field names (all 30 tables here, because the app's edges name all of them) and builds no native validator; a first `paginationOpts` or `pageDto` on `payments` reads the native table and DTO of `payments` only. `test/relations-lazy.test.ts` (R22) pins this, so that phase changed nothing.

On the request fixture (`node scripts/bench-request.mjs`), the v2 bundle fell from 190.5 KB to 189.7 KB; the session's first run of that bench was taken under load, so its timings are not compared.
