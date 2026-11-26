# v1 table parity snapshot

`v1-tables.snapshot.json` pins what the v1 Zod tables (`zodTable`, `createTable`, `tenantTable`, `zodVariantTable`) store and expose, so v2 `kTable` can prove it keeps the same stored shape and indexes (plan R15 / U9). `v1-fixtures.ts` declares 21 small tables, one per shape feature. For each one, `v1-snapshot.test.ts` records `table.export()` (document validator and indexes). It also records the input-side (kit `zodToConvex`) and output-side (`zodOutputToConvex`) native JSON of every derived boundary, plus a `behaviour` section of observed parse and `toPublicDto` results. Keys are sorted. `undefined` is written as `"$undefined"` and a bigint as `"$bigint:<n>"`.

The test compares parsed JSON, so running `vp fmt` on the file is harmless. It writes the file when it is missing. To regenerate it from v1: `npx vp test run test/parity/v1-snapshot.test.ts -u`.

Findings v2 must match:

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
