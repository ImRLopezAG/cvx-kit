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
