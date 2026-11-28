# v1 parity snapshots

The snapshots in this directory are frozen v1 output, recorded from the Zod implementation at commit `8d979a5` (cvx-kit 0.1.35). v1 has been removed from this tree, so they can no longer be regenerated here; treat them as fixed baselines and never rewrite them from v2 output.

- `v1-tables.snapshot.json` pins what the v1 Zod tables (`zodTable`, `createTable`, `tenantTable`, `zodVariantTable`) stored and exposed for 21 small tables, one per shape feature: `table.export()` (document validator and indexes), the input-side and output-side native JSON of every derived boundary, and a `behaviour` section of observed parse and `toPublicDto` results. `v2-parity.test.ts` proves the `kTable` translations in `v2-fixtures.ts` keep the same stored shape and indexes (plan R15 / U9) and lists every intended difference.
- `v1-pagination.snapshot.json` pins the pagination, filter-contract and cursor wire forms; `pagination-snapshot.test.ts` checks v2 produces them and opens the sealed v1 tokens.
- `v1-relation-page.snapshot.json` pins relation page rows and cursors; `relation-page.test.ts` checks v2 returns the same.

Keys are sorted. `undefined` is written as `"$undefined"` and a bigint as `"$bigint:<n>"`. The tests compare parsed JSON, so running `vp fmt` on the files is harmless.

Findings about v1 that v2 must match:

- Storage, `boundary.table` and function args use the input-side converter. Returns use the output-side one.
- Defaulted fields are stored optional and are optional on input. On output they are required. `insertSchema`, `commandInput`, `storage` and `toPublicDto` all fill the default.
- `z.object`, `z.strictObject`, `z.looseObject` and `.catchall` all become the same closed `v.object`. At parse time, `z.object` strips unknown keys, `z.strictObject` rejects them, and `z.looseObject` and `.catchall` keep them. Convex would then reject those kept keys on write.
- `.nullable()` gives `union(T, null)` as a required field. Every optional and nullable ordering, including `nullish`, gives an optional `union(T, null)`.
- An enum is a union of literals. A one-value enum is a one-member union, not a bare literal.
- Records become `record(string, V)`. Discriminated unions become a plain `union` of objects. `bigint` becomes `int64`. `z.any` and `z.unknown` become `any`. `z.json` becomes a six-member union.
- `zodTable` always adds optional `createdAt`, `updatedAt` and `archivedAt` numbers. `tenantTable` adds a required `tenant` string.
- A variant table stores a top-level union of branch objects. It adds timestamps only with `timestamps: true`.
- `toPublicDto` re-parses the public fields. This re-runs defaults, trims and transforms. It drops fields that are not public and keeps missing optional keys as `undefined`.
- Known v1 quirks: `updateSchema.parse({})` fills defaults, so a partial patch overwrites stored values. A transformed field is stored as its input type. `tenantTable` cannot infer extra `serverFields`.
