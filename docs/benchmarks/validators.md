# Validator layer benchmark

Compares four ways of declaring the same schemas: classic Zod 4, `zod/mini`, plain Convex `v.*`, and `k` (`src/k`).
Convex re-evaluates a function's import graph on every call, so the cost that matters is declaring schemas at module load.

## How it is measured

`node scripts/bench-validators.mjs` emits one module per flavor from a neutral descriptor, bundles it the way Convex does (esbuild, browser, ESM, `convex,module` conditions), and imports it in fresh processes.

- **declare** is the time and retained heap of importing the module.
- **+native** also builds every native Convex validator, plus a `defineTable` and a query registration per group. Convex needs these at deploy analysis and schema export, not on each call.
- **Types** and **Instantiations** come from `tsc --extendedDiagnostics` on the emitted source.
- Figures are medians of 15 rounds with the starting flavor rotated. Machine: node v26.13.1, darwin arm64. Zod 4.6.5, convex 1.48.0.

The `convex` flavor cannot express checks or defaults, so it declares structure only. The Zod flavors and `k` declare the same checks.

## Synthetic workload

400 schemas and 57 table-and-function groups, generated with seed 1 from the call-site mix of two consumer apps.

| flavor | bundle KB | zod KB | declare ms | declare MB | +native ms | +native MB | Types | Instantiations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zod | 853.1 | 581.9 | 32.26 | 17.18 | 42.27 | 18.29 | 240071 | 2139108 |
| zod-mini | 324.3 | 115.5 | 19.71 | 10.86 | 31.29 | 11.96 | 220446 | 2145139 |
| convex | 276.5 | 0.0 | 9.63 | 2.49 | 10.13 | 2.58 | 43200 | 296109 |
| k | 264.3 | 0.0 | 6.63 | 2.17 | 11.26 | 3.45 | 63040 | 339573 |

## A real module's schema graph

The schemas a consumer app's finance contracts declare on import, with the tables they reference: 350 schemas and 11 groups.
The descriptor is kept outside this repository because the app is private.
Refinements, 39 in that module, have no descriptor form and are left out of every flavor.

| flavor | bundle KB | zod KB | declare ms | declare MB | +native ms | +native MB | Types | Instantiations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zod | 782.4 | 581.9 | 23.05 | 10.55 | 35.72 | 11.93 | 124840 | 1319951 |
| zod-mini | 285.2 | 115.5 | 13.33 | 6.31 | 26.05 | 7.67 | 116772 | 1319919 |
| convex | 201.3 | 0.0 | 6.06 | 1.54 | 6.42 | 1.57 | 20595 | 194063 |
| k | 196.5 | 0.0 | 4.24 | 1.43 | 7.23 | 2.07 | 34512 | 220395 |

`k` itself is 4.7 KB of the bundle. The Zod flavor carries 582 KB of Zod, and `zod/mini` still carries 115 KB because the Convex id helper imports classic Zod.

## Gate

The plan allowed v2 to proceed only if none of four stop conditions held. Measured on the real module's graph:

| Stop condition | Threshold | Measured | Holds |
|---|---|---|---|
| Module eval gain against classic Zod too small | less than 50% lower | 81.6% lower (23.05 ms to 4.24 ms) | no |
| `k` not clearly better than the `zod/mini` gain | within 10 points | `zod/mini` 42.2%, `k` 81.6% | no |
| `k` costs too much over plain `v.*` | more than 15% slower | 30% faster to declare; 12.6% slower when every native validator is forced | no |
| Type cost regresses | more instantiations than classic Zod | 220,395 against 1,319,951 | no |

Retained heap falls from 10.55 MB to 1.43 MB.

## Limits of this measurement

- It measures the schema layer. A whole request also loads the kit's tables, relations and query engine; the per-request figures are in `docs/benchmarks/module-load.md`.
- `k`'s type figures include checking `src/k` itself, about 21,000 instantiations, while Zod and Convex ship declaration files that `skipLibCheck` skips.
- `k` declares faster than plain `v.*` because it records a chain and builds nothing else until a validator is read.

## Whole request: tables, auth and one function module

`node scripts/bench-request.mjs --runs 15` compares one Convex function module of the same app declared with v1 (Zod, `zodTable`, `createAuthFunctions`) and with v2 (`k`, `kTable`, `createKAuthFunctions`).
The fixtures in `scripts/bench/request/` declare the 30 table boundaries of `scripts/bench/app-fixture.ts` (28 entity tables and two variant tables) and its auth builders with the same triggers and tenancy settings, then register five operations of one domain through `authMutation` and `authQuery`: `create`, `update`, `get`, `list` and `archive`.
Relations, the query engine and domain contracts are not on `k` yet, so the fixture leaves them out; `docs/benchmarks/module-load.md` covers the full v1 app with them.
`eager` declares `args` and `returns` as properties, `getter` as accessors.
Each case is bundled the way Convex does and loaded in a fresh process per sample.
Export ms is `exportArgs()` plus `exportReturns()` on all five functions, the deploy-analysis path where native validators are built.
First-call and warm-call time is `create` invoked through Convex's `invokeMutation` hook with JSON args and a stubbed identity syscall; warm is the mean of 200 further calls.
Before measuring, the bench checks that every case pushes byte-identical `exportArgs` and `exportReturns` JSON for all five functions, returns the same results for valid calls and rejects a `create` whose title fails `min(1)`. No normalisation was needed.

| case | bundle KB | zod KB | load ms | retained MB | tables ms | auth ms | registration ms | export ms | first-call ms | warm-call µs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v1 eager | 767.1 | 581.9 | 15.40 | 4.43 | 3.95 | 0.16 | 0.46 | 0.60 | 1.68 | 28.4 |
| v1 getter | 767.1 | 581.9 | 15.07 | 4.36 | 3.99 | 0.16 | 0.16 | 0.93 | 1.78 | 28.6 |
| v2 eager | 749.3 | 581.9 | 10.24 | 3.75 | 0.70 | 0.16 | 0.32 | 0.64 | 0.79 | 25.5 |
| v2 getter | 749.3 | 581.9 | 10.16 | 3.73 | 0.70 | 0.16 | 0.16 | 0.81 | 0.86 | 25.4 |
| v2 projected eager | 163.4 | 0.0 | 3.54 | 0.94 | 0.73 | 0.18 | 0.32 | 0.62 | 0.81 | 25.6 |
| v2 projected getter | 163.4 | 0.0 | 3.35 | 0.92 | 0.71 | 0.18 | 0.16 | 0.79 | 0.84 | 25.8 |

| bytes | v1 eager | v1 getter | v2 eager | v2 getter | v2 projected eager | v2 projected getter |
|---|---:|---:|---:|---:|---:|---:|
| (glue) | 6879 | 6879 | 6667 | 6667 | 2840 | 2840 |
| (stub) | 0 | 0 | 0 | 0 | 79 | 79 |
| convex | 73128 | 73128 | 73035 | 73035 | 72942 | 72942 |
| convex-helpers | 16579 | 16579 | 14292 | 14292 | 14292 | 14292 |
| fixture | 4614 | 4614 | 4609 | 4609 | 4609 | 4609 |
| src (rest) | 59297 | 59297 | 43372 | 43372 | 43267 | 43267 |
| src/k | 29069 | 29069 | 29379 | 29379 | 29294 | 29294 |
| zod | 595897 | 595897 | 595902 | 595902 | 0 | 0 |
| total | 785463 | 785463 | 767256 | 767256 | 167323 | 167323 |

```text
v2 eager vs v1 eager: load ms -33.5%, retained MB -15.3%, bundle KB -2.3%
v2 projected eager vs v1 eager: load ms -77.0%, retained MB -78.8%, bundle KB -78.7%
v2 getter vs v1 getter: load ms -32.6%, retained MB -14.3%, bundle KB -2.3%
v2 projected getter vs v1 getter: load ms -77.8%, retained MB -78.9%, bundle KB -78.7%

node v26.13.1, darwin arm64, Apple M5, runs=15, warm calls=200
```

Until the cutover unit, `src/auth.ts` imports `zod` and `./zod-registration` for its v1 constructors.
The v2 bundle uses neither, but Zod's modules are not marked side-effect free, so the import keeps all 581.9 KB of Zod in it; the v1 kit modules themselves (`src/zod-registration.ts`, `src/zod-convex.ts`) are tree-shaken to 0 bytes.
The same import pattern puts 29 KB of `src/k` into the v1 bundle.
The projected rows bundle the v2 entry with those two imports of `src/auth.ts` replaced by stubs that throw on any use; the five functions still register, export the same JSON and answer every call identically, so the rows show v2 once the cutover removes the imports.

What did not improve: export ms is the same on both sides (0.60 against 0.64 ms eager), because both build the same native validators on first read; and the warm call is 10% faster at most, since a call spends most of its time in the auth and row-level-security wrappers, and in production Convex checks argument structure outside the isolate.
The gain is at module load: declaring the 30 tables drops from about 4 ms to 0.7 ms, and Zod's own evaluation accounts for most of the remaining load difference between v2 and projected v2.
