# Module-load benchmark

Run from this checkout with `node scripts/bench-relations.mjs <source-root> 11 module-load`.
The baseline is a source-only `git archive` of 6cbbb1532a7f29de7efa17cd6888b92184e735ca (cvx-kit 0.1.25), with the identical new fixture copied in and the same installed dependencies. The harness bundles with Convex/module conditions and loads in 11 fresh Node processes with `--jitless`; values are medians in milliseconds. The measured import includes evaluation and loading of the bundled dependency graph, excluding process startup. No database/provider calls or handler executions occur.

| Phase                | 0.1.25 object contracts | 0.1.26 object contracts | 0.1.26 thunk contracts |
| -------------------- | ----------------------: | ----------------------: | ---------------------: |
| Cold module load     |                    66.2 |                    52.4 |                   29.1 |
| Table declaration    |                    23.2 |                    10.4 |                   10.4 |
| Relation declaration |                     1.6 |                     1.6 |                    1.9 |
| 30 contract pairs    |                    24.7 |                    23.9 |                    0.4 |
| 20 registries        |                     0.3 |                     0.2 |                    0.1 |

Fixture: 87 tables (84 generated entities, tasks, payments and notes), 30 scalar-pagination/relation-page contract pairs, 20 Effect Query registries. Object contracts exercise transparent changes. Append `lazy-contracts` to exercise the optional new thunk API, which defers schema construction until read. No first-execution latency claim is made; deferred work occurs on use. Local results do not establish deployed Convex latency.

Environment: Node v26.13.0 on macOS; identical dependencies and bundler for both sources. Phase medians are independently calculated, so they need not sum to the load median.
