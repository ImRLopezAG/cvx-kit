# cvx-kit 2 benchmark record

v1 is cvx-kit 0.1.35 (Zod, commit `8d979a5`). v2 is this tree (`k`, `kTable`, `kVariantTable`, no Zod in the core).

## Summary: the full representative app

The app has 30 table boundaries (28 entity tables and two variant tables), relations with 34 joins, three thunk domain contracts with compact relation pagination over the variant tables, and auth builders with triggers and tenancy; one function module registers the 14 operations of one contract.
Figures are for the `eager` variant (`args` and `returns` declared as properties); the `getter` variant is in the full tables below.

| metric | v1 | v2 | change |
|---|---:|---:|---:|
| bundle KB | 815.8 | 218.1 | -73.3% |
| Zod KB in bundle | 582.1 | 0.0 | -100% |
| module load ms | 27.42 | 7.89 | -71.2% |
| retained heap MB | 9.36 | 2.12 | -77.3% |
| first validator build for one function (`listPayments`) ms | 3.04 | 3.32 | +9.0% |
| first call ms (whole request without relations, `create`) | 1.53 | 0.84 | -45.2% |
| tsc instantiations (fixture and the kit source it imports) | 804,286 | 257,654 | -68.0% |

The first-call row comes from the smaller request fixture in section (d), because the full app's harness builds validators but does not call a function.

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

| case | functions | bundle KB | zod KB | load ms | retained MB | tables ms | defineRelations ms | contractsAndAuth ms | registration ms | invoke ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v1-eager | 14 | 815.8 | 582.1 | 27.42 | 9.36 | 3.68 | 1.52 | 0.25 | 9.83 | 3.04 |
| v1-getter | 14 | 815.9 | 582.1 | 17.95 | 6.41 | 3.68 | 1.53 | 0.25 | 0.23 | 7.93 |
| v2-eager | 14 | 218.1 | 0.0 | 7.89 | 2.12 | 0.69 | 1.78 | 0.26 | 2.30 | 3.32 |
| v2-getter | 14 | 218.2 | 0.0 | 5.82 | 1.84 | 0.69 | 1.79 | 0.26 | 0.24 | 4.69 |

Bytes in the bundle by owner:

| bytes | v1-eager | v1-getter | v2-eager | v2-getter |
|---|---:|---:|---:|---:|
| zod | 596021 | 596021 | 0 | 0 |
| convex | 73158 | 73158 | 72983 | 72983 |
| convex-helpers | 16579 | 16579 | 15162 | 15162 |
| cvx-kit | 124794 | 124794 | 125546 | 125546 |
| fixture | 6515 | 6615 | 6565 | 6665 |
| (glue) | 18337 | 18337 | 3037 | 3037 |
| total | 835404 | 835504 | 223293 | 223393 |

```text
v2-eager vs v1-eager: load ms -71.2%, retained MB -77.3%, bundle KB -73.3%, invoke ms 9.0%
v2-getter vs v1-getter: load ms -67.6%, retained MB -71.2%, bundle KB -73.3%, invoke ms -40.8%
```

Export parity: `exportArgs()`/`exportReturns()` JSON of all 14 functions is identical across v1-eager, v1-getter, v2-eager and v2-getter. No normalisation was applied; the fixture declares no `tools.*` ids and no `.optional().default()` field, the two documented v1 to v2 validator differences.

### Type cost

`--types` runs `tsc --extendedDiagnostics` (strict, bundler resolution, `skipLibCheck`) on each side's entry. The kit is imported as source on both sides, so the figures include checking the kit's own files.

| types | files | Types | Instantiations | Check ms |
|---|---:|---:|---:|---:|
| v1 | 372 | 301869 | 804286 | 231 |
| v2 | 284 | 101625 | 257654 | 81 |

Both sides typecheck with zero errors. The v1 fixture at `8d979a5` was only ever bundled and has three type errors: in `appSchemaTables` a union of `.index` overloads is not callable, and the `{ ...entities, payments, ledger }` spread in `defineAppTables` drops the generated index signature, so `tables[domain]` is untyped. For `--types` only, the bench applies to the extracted v1 copy the two edits the v2 fixture carries (`v1TypePatches` in the script): `Object.assign(entities, { payments, ledger })`, and `appSchemaTables` indexing the variant tables by name. The entry never calls `appSchemaTables`, and the runtime figures use the unedited v1 fixture.

## Whole request without relations (`scripts/bench-request.mjs`)

The fixtures in `scripts/bench/request/` declare the 30 table boundaries and the auth builders of the app above, without relations or contracts, and register five operations of one domain through `authMutation` and `authQuery`: `create`, `update`, `get`, `list` and `archive`.
Export ms is `exportArgs()` plus `exportReturns()` on all five functions, the deploy-analysis path.
First-call and warm-call time is `create` invoked through Convex's `invokeMutation` hook with JSON args and a stubbed identity syscall; warm is the mean of 200 further calls.
The bench also checks that both sides return the same results for valid calls and reject a `create` whose title fails `min(1)`.

| case | bundle KB | zod KB | load ms | retained MB | tables ms | auth ms | registration ms | export ms | first-call ms | warm-call µs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v1 eager | 752.5 | 581.9 | 14.93 | 4.28 | 3.94 | 0.13 | 0.45 | 0.61 | 1.53 | 27.5 |
| v1 getter | 752.5 | 581.9 | 14.71 | 4.21 | 3.96 | 0.13 | 0.16 | 0.94 | 1.65 | 28.1 |
| v2 eager | 179.1 | 0.0 | 3.58 | 0.97 | 0.71 | 0.15 | 0.32 | 0.67 | 0.84 | 25.3 |
| v2 getter | 179.1 | 0.0 | 3.40 | 1.51 | 0.71 | 0.15 | 0.15 | 0.85 | 0.84 | 25.2 |

| bytes | v1 eager | v1 getter | v2 eager | v2 getter |
|---|---:|---:|---:|---:|
| (glue) | 18190 | 18190 | 2926 | 2926 |
| convex | 73128 | 73128 | 72942 | 72942 |
| convex-helpers | 16579 | 16579 | 15162 | 15162 |
| fixture | 4614 | 4614 | 4609 | 4609 |
| src (rest) | 62178 | 62178 | 58116 | 58116 |
| src/k | 0 | 0 | 29635 | 29635 |
| zod | 595906 | 595906 | 0 | 0 |
| total | 770595 | 770595 | 183390 | 183390 |

```text
v2 eager vs v1 eager: load ms -76.0%, retained MB -77.3%, bundle KB -76.2%, export ms 9.8%, first call ms -45.2%, warm call -8.3%
v2 getter vs v1 getter: load ms -76.9%, retained MB -64.2%, bundle KB -76.2%, export ms -9.6%, first call ms -49.2%, warm call -10.1%
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

| flavor | bundle KB | zod KB | declare ms | declare MB | +native ms | +native MB | Types | Instantiations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zod | 853.1 | 581.9 | 32.17 | 17.19 | 42.36 | 18.30 | 240071 | 2139108 |
| zod-mini | 324.3 | 115.5 | 19.80 | 10.86 | 31.22 | 11.97 | 220446 | 2145139 |
| convex | 276.5 | 0.0 | 9.71 | 2.49 | 10.16 | 2.58 | 43200 | 296109 |
| k | 288.4 | 0.0 | 7.13 | 2.39 | 11.56 | 3.67 | 70897 | 369471 |

| bytes | zod | zod-mini | convex | k |
|---|---:|---:|---:|---:|
| (glue) | 13542 | 10532 | 9570 | 9766 |
| convex | 59263 | 59230 | 59055 | 59103 |
| convex-helpers | 4731 | 4731 | 0 | 0 |
| schemas | 200170 | 139329 | 214521 | 197173 |
| src/k | 0 | 0 | 0 | 29264 |
| zod | 595868 | 118257 | 0 | 0 |
| total | 873574 | 332079 | 283146 | 295306 |

### A real module's schema graph

The schemas a consumer app's finance contracts declare on import, with the tables they reference: 350 schemas and 11 groups.
The descriptor is kept outside this repository because the app is private; it was re-run on the final tree.
Refinements, 39 in that module, have no descriptor form and are left out of every flavor.

| flavor | bundle KB | zod KB | declare ms | declare MB | +native ms | +native MB | Types | Instantiations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zod | 782.4 | 581.9 | 23.12 | 10.56 | 35.32 | 11.93 | 124840 | 1319951 |
| zod-mini | 285.2 | 115.5 | 13.44 | 6.32 | 26.14 | 7.68 | 116772 | 1319919 |
| convex | 201.3 | 0.0 | 6.11 | 1.54 | 6.39 | 1.57 | 20595 | 194063 |
| k | 220.6 | 0.0 | 4.64 | 1.61 | 7.84 | 2.25 | 42004 | 240646 |

| bytes | zod | zod-mini | convex | k |
|---|---:|---:|---:|---:|
| (glue) | 16410 | 13400 | 12425 | 12623 |
| convex | 59325 | 59281 | 59132 | 59156 |
| convex-helpers | 4731 | 4731 | 0 | 0 |
| schemas | 124774 | 96340 | 134572 | 124807 |
| src/k | 0 | 0 | 0 | 29322 |
| zod | 595913 | 118261 | 0 | 0 |
| total | 801153 | 292013 | 206129 | 225908 |

`zod/mini` still carries 115 KB of Zod because the Convex id helper imports classic Zod.

## Spike gate (as recorded at the prototype stage)

The plan allowed v2 to proceed only if none of four stop conditions held. Measured on the real module's graph with the prototype `k` (which was 4.7 KB of the bundle):

| Stop condition | Threshold | Measured | Holds |
|---|---|---|---|
| Module eval gain against classic Zod too small | less than 50% lower | 81.6% lower (23.05 ms to 4.24 ms) | no |
| `k` not clearly better than the `zod/mini` gain | within 10 points | `zod/mini` 42.2%, `k` 81.6% | no |
| `k` costs too much over plain `v.*` | more than 15% slower | 30% faster to declare; 12.6% slower when every native validator is forced | no |
| Type cost regresses | more instantiations than classic Zod | 220,395 against 1,319,951 | no |

The same conditions on the final `k` (table above): 79.9% lower than classic Zod (23.12 ms to 4.64 ms); `zod/mini` 41.9% against `k` 79.9%; 24.1% faster than `v.*` to declare and 22.7% slower when every native validator is forced; 240,646 instantiations against 1,319,951.

## What did not improve or got worse

- The finished `k` is larger and slower than the prototype the gate passed on. On the real module's graph, `src/k` grew from 4.7 KB to 29.3 KB of the bundle, declare time from 4.24 ms to 4.64 ms, forced-native time from 7.23 ms to 7.84 ms and instantiations from 220,395 to 240,646. On the synthetic workload the `k` bundle went from 264.3 KB to 288.4 KB, which is now 11.9 KB more than plain `v.*` (276.5 KB).
- With every native validator forced, `k` is 13.8% slower than plain `v.*` on the synthetic workload (11.56 ms against 10.16 ms) and 22.7% slower on the real module's graph (7.84 ms against 6.39 ms). The second figure is above the gate's 15% threshold; the gate was decided on declare time, where `k` is faster than `v.*` (4.64 ms against 6.11 ms).
- Building validators on first read is not faster. In the full app, building `listPayments`'s validators takes 3.32 ms against 3.04 ms in v1 (+9.0%, eager). In the request fixture, exporting all five functions' validators takes 0.67 ms against 0.61 ms (+9.8%, eager) and 0.85 ms against 0.94 ms (-9.6%, getter): the deploy-analysis cost is the same within noise.
- `defineRelations` is slower: 1.78 ms against 1.52 ms (+17.1%, eager) and 1.79 ms against 1.53 ms (getter).
- `contractsAndAuth` is unchanged (0.26 ms against 0.25 ms), and auth construction in the request fixture is 0.15 ms against 0.13 ms.
- The warm call is 8.3% (eager) to 10.1% (getter) faster; a call spends most of its time in the auth and row-level-security wrappers, and in production Convex checks argument structure outside the isolate.
- The kit's own code is not smaller. cvx-kit contributes 125,546 bytes to the v2 app bundle against 124,794 in v1 (+0.6%); the bundle shrinks because Zod (596,021 bytes), its ESM glue and part of `convex-helpers` leave it.
- In the request fixture the v2 getter variant retains more heap than the v2 eager variant (1.51 MB against 0.97 MB), unlike v1 (4.21 MB against 4.28 MB). This was not investigated.

## Limits of the measurement

- Local machine (Apple M5), not a deployed Convex isolate. The earlier observation is that a deployed isolate takes roughly four times the local figure.
- The app is synthetic: generated tables and contracts shaped like a consumer app, not a consumer app.
- Medians of 15 fresh-process rounds; sub-millisecond phases are close to timer and scheduling noise.
- Type figures check the kit as source on both sides, so they include the kit's own files, which a consumer would read as declaration files under `skipLibCheck`.
- The consumer-app figures that motivated this work (175–250 ms and 24–40 MB per API module) were measured on a real app that has not been migrated to v2, so the gain on a real app is not yet measured.
- The 0.1.x per-request figures, before v2, are in `docs/benchmarks/module-load.md`.
