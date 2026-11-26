# Changelog

All notable changes to cvx-kit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**Semver contract (from 0.1.0):** while on 0.x, breaking changes land only on
minor bumps; patches are additive or fixes. The breaking window formally
closes at the follow-up consolidation release (package-name decision + full
export-name API audit) — until then, the six 0.1.0 helper surfaces may still
be renamed in a minor. Every release tag gets a GitHub Release whose notes
are this file's matching section.

## [Unreleased]

These changes are planned as 2.0.0, a breaking release that removes Zod from the kit. Follow the [2.0 migration guide](https://github.com/ImRLopezAG/cvx-kit/blob/main/skills/cvx-kit/references/migration-v2.md); the codemod in `tools/codemod-v2/` rewrites the mechanical call sites and reports the rest.

### Breaking

- Zod is removed from every core entry. Schemas are written with `k` (`cvx-kit`, `cvx-kit/k`), whose schemas carry plain native Convex validators. `zod` is now an optional peer, needed only for `cvx-kit/zod`.
- `cvx-kit/zod-table` is removed. `zodTable` is `kTable`, `zodVariantTable` is `kVariantTable`, and the table builders and types move to `cvx-kit/table` (also exported from `cvx-kit`). Fields are a plain object, not a callback, and ids are `k.id('table')`. `zid`, `jsonSafeZid`, `zodToConvex` and `convexToZod` are removed.
- `zodContract` is `kContract` (synchronous decoding) and `effectZodApiBuilder` is `effectApiBuilder`, one builder for `k` schemas and native validators.
- Validation failures raised by the kit are a `ConvexError` with data `{ code: 'VALIDATION', issues: [{ path, code, message }] }` (`KValidationError`), replacing `ConvexError({ ZodError })`. Structural arg failures raised by Convex keep Convex's error. `safeParse` returns `{ success, issues }` on failure, with no `.error`.
- `k.object` is strict by default: parse rejects unknown keys where `z.object` stripped them. `.strip()` restores stripping. `catchall`, recursive schemas, tuples, `custom`/`instanceof`, `coerce`/`preprocess` and `meta` are not supported in 2.0.
- The kit no longer parses return values. Convex validates them against the output-side validator, so a handler that returns more fields than `returns` declares now fails; return `toPublicDto(row)`. A transforming `returns` schema is rejected, return refinements do not run, and `returns` must be a schema, not a plain field object.
- `k.record` with an enum, string literal or union-of-literals key builds a strict object with one required field per value (v1's shape for `z.record(z.enum(...), v)`); a native record with literal keys is refused by Convex at push. `k.partialRecord` builds the optional-keys form. Other key kinds are a type error and throw at declaration. Object field names Convex refuses (leading `$`, empty, non-ASCII, over 1024 characters) throw when the validator is first built.
- `transform` and `pipe` are rejected on table fields and return shapes; `trim`, `toLowerCase`, `toUpperCase` and `overwrite` stay allowed everywhere. Refinements and checks are synchronous; `superRefine` becomes `check`.
- `insert`, `update`, `pick` and `omit` take string keys instead of `{ key: true }` masks. Table boundaries are accessors built on first read; an object spread copies them (building each), so `{ ...table, table: other }` replaces one member. Use `withFieldGroups` for field groups.
- Ids are branded on input: `k.input` keeps `Id<'table'>`.
- `k.number()` accepts `NaN` and infinities, as native `v.number()` does, and `int()` no longer caps at the safe-integer range.
- Out-of-range search options fail with `VALIDATION` instead of `SearchError('SEARCH_OPTIONS_UNSUPPORTED')`.
- `AgentToolRecord.args` is a `k` schema; `approvalCallbackInput` is a `k` object and `approvalCallbackArgs` its native validator.
- `k.record` keys must satisfy Convex's record-key rule after normalisation (non-empty, at most 1024 characters, printable ASCII, not starting with `$` or `_`); others fail with `invalid_format` at that key.
- `k.timestamp()` accepts 1970-01-01T00:00:00.000Z through 9999-12-31T23:59:59.999Z; date conversions outside that range report an `invalid_value` issue instead of throwing.
- Containers passed to `k.enum`, `k.union`, `k.discriminatedUnion`, `k.record` and `refine` options are frozen at declaration, and an object's field map is frozen when `.shape` is first read; `withFieldGroups` copies and freezes its map. Mutating a shared array or field object afterwards throws.
- A `k.discriminatedUnion` whose options share a discriminator value throws when first used.
- `k.input` of `k.object({})` is `{ readonly [key: string]: never }`, so an empty input rejects extra properties at the type level.
- `pick`, `omit`, `extend` (including `extend({})`), `partial` and `required` on an object with object-level `refine`/`check`/`overwrite` throw at declaration instead of silently dropping them. Pass `{ dropChecks: true }` as the last argument to drop them, or `extend(fields, { keepChecks: true })` to keep them. The codemod reports such sites as `derive-drops-checks`.
- `k.object` parses plain objects only. A class instance fails with `expected a plain object, received an instance of …`; a `.strip()` object parses one from its own enumerable properties.

- `argumentFailure` (added in 0.2.0) no longer has a `'legacy'` policy. The default is `'validation'`, which throws `KValidationError` (`ConvexError({ code: 'VALIDATION', issues })`); `'declared'` and a function hook work as in 0.2.0. `zCustomFunctions` is `kCustomFunctions` in `cvx-kit/registration`.

### Added

- `createEffectFoundation({ argumentFailure })` applies the argument failure policy to Effect command, query and action `input` validation, including nested `exec`. By default a `k` input that fails reaches the client as `{ code: 'VALIDATION', issues }`; before, an API adapter with an `errors` projection reduced it to `UnknownFailure`. `'declared'` throws `INVALID_ARGUMENTS`.
- `cvx-kit/k`: `k` factories (including `k.isoDate()`, `k.isoDateTime()`, `k.timestamp()` and their input conversions), chain methods, `parse`/`safeParse`, `k.infer`/`k.input`/`k.output`, Standard Schema v1 on every schema, and `KValidationError`.
- `cvx-kit/table`: `kTable`, `createTable`, `tenantTable`, `kVariantTable` and the table types.
- `cvx-kit/registration`: `kCustomQuery`, `kCustomMutation`, `kCustomAction` and `rawFunctionArgs`.
- `cvx-kit/json-schema`: `toJsonSchema`, which renders ids as strings.
- `cvx-kit/zod`: `toZod(schema)` and `.toZod()`, a one-way conversion to Zod 4. The result is a `zod/mini` schema, so the entry bundles Zod's core and not the classic method API: about 152 KB with `k` (73 KB of it Zod), against 815 KB when it was built on classic Zod. Extend a result with `zod/mini` functions. An id converts to `z.string()` typed as the table's `Id`, and `kZodIds.get(schema)?.tableName` names its table; convex-helpers' `zodToConvex` reads such an id as a plain string.
- `withFieldGroups` in `cvx-kit/relations` and `AgentListArgs` in `cvx-kit/agent-tools`.
- A codemod, `npx cvx-kit-codemod-v2 <path…> [--write] [--report out.json]`, shipped in the package as the `cvx-kit-codemod-v2` bin (also `node tools/codemod-v2/index.mjs` from a checkout).
- The package ships `CHANGELOG.md` and the skill references (`skills/cvx-kit/references/*.md`, including this migration guide), so the docs match the installed version.

### Added (since 2.0.0-beta.0)

- Importing `cvx-kit/json-schema` makes every `k` schema implement Standard JSON Schema v1 (`~standard.jsonSchema.input/output({ target: 'draft-2020-12' | 'draft-07' })`), so libraries such as TanStack AI take `k` tool schemas directly. Without the import the property is absent and the converter stays out of the bundle. `toJsonSchema(schema, { refs: true })` emits repeated sub-schemas once under `$defs` (opt-in; default output unchanged).
- `k.partialRecord(key, value)`.
- `KCustomCtx<typeof builder>` (`cvx-kit/registration`, `cvx-kit`): the handler ctx of a `KCustomBuilder`, replacing convex-helpers' `ZCustomCtx`. `KCustomBuilder` is also exported from `cvx-kit`.
- `AnyKSchema` (a parameter type for any `k` schema) and `KRecordKey` from `cvx-kit/k`; `KCursorSchema` from `cvx-kit/querying`.
- Zod-parity members: `KArray.element`, `KObject.keyof()`, `KObject.required(...keys)`, `k.enum(...).exclude/extract/.enum`, number `.positive()`, `.negative()`, `.nonnegative()`, `.nonpositive()`, `.finite()`, `.safe()`, and `removeDefault()` (an alias of `unwrap()` on a default). The number checks leave the native validator unchanged; `toJsonSchema` and `toZod` describe them.
- `toJsonSchema(schema, { io: 'output' })` describes the output side.
- `.catch(fallback)` on every `k` schema, as Zod 4's `catch`: a value or `({ issues, input }) => value` replaces a value that fails. Its input-side native validator is `v.any()`, so the kit validates the whole value at a function boundary; table fields and `returns` reject it. `toZod` throws on it (not carried), and the codemod rewrites `.catch(...)` instead of reporting it.
- `k.object(...).loose()` and `k.looseObject(fields)`: parse keeps unknown keys (hardened like `.strip()`); the native validator stays the closed object v1 exported for `z.looseObject`. `k.jsonObject()`: a plain object of JSON values with any keys Convex accepts in an object value (`_id` included, no leading `$`), natively `v.any()`. The codemod rewrites `z.looseObject`, `.passthrough()` and `.loose()`.

- `transform` callbacks take the `check` context as a second parameter: `context.addIssue({ message, path?, code? })` fails the parse with those issues, at the transformed value's location, on every path (`parse`, `safeParse`, the function boundary, Standard Schema, Effect operation input). `k.NEVER` (typed `never`) is the value to return after adding an issue. One-parameter transforms are unchanged and get no context. The codemod rewrites a Zod transform whose `ctx.addIssue({ code: 'custom', message, path })` and `return z.NEVER` map directly, and reports `transform-issue` otherwise (it previously left such a unit on Zod as `unknown-factory`, or rewrote a non-custom `addIssue` without a report).

### Fixed (since 2.0.0-beta.0)

- Codemod: the keep marker accepts a reason (`// cvx-kit-codemod: keep-zod -- reason`); kit entry imports and renamed kit names are rewritten in every file, and moved names merge into an existing import of their module; a file importing `k` from `cvx-kit/k` is no longer skipped as a `k` conflict, so re-runs pick up the remaining Zod; `zCustomQuery`/`zCustomMutation`/`zCustomAction`/`ZCustomCtx` from convex-helpers become the `k` builders and `KCustomCtx`; the new number checks and `.check` are rewritten directly, and Zod-only chain spellings on `k` schemas and table members are rewritten, or reported (`unproven-mask`, `unproven-strict`) when the root cannot be proven; a type helper is rewritten only when its schema is known to be `k` (`type-helper-unknown` otherwise); objects that are parsed get `.strip()` by default (`--no-strip-parsed` to keep them strict) and are reported apart from boundary-only objects; table spreads are reported.
- An object spread of a table boundary (`{ ...table, table: other }`) keeps `schema`, `publicDto`, `storage` and the other lazy members, for `kTable`, `createTable`, `tenantTable` and `kVariantTable`.
- `k.object` rejected class instances with `expected object, received object`; see the plain-object entry above.
- `k.infer` of an object holding a `k.any()` field beside a defaulted field made the `any` field optional.
- `refine` with a type-guard predicate narrows the schema's type.
- A type-guard `refine` now narrows inside containers too: an array element, record value or union member, an object field wrapped in `.optional()`, `.nullable()` or `.default()`, derived objects, table documents and function `args` all see the narrowed type (it narrows the native validator's type, at the type level only).
- The relation index error (`No active index begins with or has a guarded prefix for "table.field"`) says when the table has no indexes in the running bundle (the module declaring them may not be imported) or lists the indexes it does have.
- `KValidationError` is built without stack frames, so a validation failure on a dev backend no longer prints kit-internal frames as if it were a crash. Other errors keep their stacks.
- `k.discriminatedUnion` accepts a discriminator that is a union of literals (`k.union([k.literal('a'), k.literal('b')])`), dispatching on each value. An unsupported discriminator, a missing key or a repeated value now throws at declaration, naming the key, the option index and what was found, instead of on first use.
- The error for a transforming `returns` schema names the field path that transforms and says what to declare instead.
- Check options read Zod 4's `error` key: `refine(fn, { error: '…' })` reported `Invalid input`. `error` is now a string alias of `message` in `refine` and in the message argument of `min`/`max`/`length`/`regex`/`int` and the number checks, which also accept an options object. A function-valued `error` is a type error and throws at declaration. The codemod rewrites inline `error:` to `message:`, reports `error-map` and the informational `check-options-by-reference`.
- Codemod: v1's number refusals are kept. `z.int()` and `z.number().int()` become `k.int().safe()` and `z.number()` becomes `k.number().finite()` (informational `int-safe-preserved`, `number-finite-preserved`); `--native-number-bounds` emits the bare forms and reports `int-no-longer-safe` / `number-now-accepts-nan`. The codemod prints its options with `--help`.
- `.catch` no longer opens holes in Convex's validation. It throws at declaration around a schema holding `k.id` at any depth (catch makes the value `v.any()` natively, and only Convex can check an id's table; `k.id(...).catch` is also a type error), on a discriminated-union option and on its discriminator field (catch the whole union instead). Three-argument `kVariantTable` and DTO extensions reject `catch` in branch fields, as ordinary table fields already did; a variant branch could store `v.any()`. A non-object given to a discriminated union is an `invalid_type` issue instead of a `TypeError`, also on the plan-only path at function boundaries.
- `toJsonSchema` and `.catch`: a caught object field is not required on the input side, and the output side emits the wrapped schema's shape without its checks, since the fallback is not validated.- Field and enum names that match `Object.prototype` members (`__proto__`, `constructor`, `toString`, `hasOwnProperty`) work everywhere: `k.object`, its derivations, finite-key records, `k.partialRecord`, `k.enum(...).enum`, both native validators, parse, JSON Schema, `toZod` and table projections build field maps with own properties, so `k.record(k.literal('__proto__'), v)` no longer loses its field. A discriminator missing from an option is no longer read through the prototype.
- `k.enum(...).extract(values)` follows the requested order at runtime, as its type and Zod 4 do; `exclude` keeps the source order.
- `k.discriminatedUnion` no longer reports a conflict when one option lists the same discriminator value twice (`k.union([k.literal('a'), k.enum(['a', 'b'])])`).
- `toPublicDto` threw `cannot project a 'jsonObject' schema` on a table with a `k.jsonObject()` public field; it now projects it (a stored non-object fails as `invalid_type`).
- `toJsonSchema` output follows what parse can produce: an optional field stays optional through a `transform` (`required` no longer lists it), a `pipe` drops the `nullable`/default declared before it, and on the input side a check after a normaliser is no longer promised (`toLowerCase().regex(...)` accepted `'AB'`; after `trim` only the lower length bound is kept). A property test checks, over about 45 schemas, that every value parse accepts validates against the input schema and every parsed output against the output schema.
- `k.jsonObject()` carries Convex's key rule into its JSON Schema (`propertyNames` pattern) and `toZod` for top-level keys; nested keys are checked by parse only.

### Changed

- The stored shape and indexes of every table are unchanged from 0.1.35, so no data migration is expected.
- `updateSchema` and `.partial()` no longer fill defaults, so a patch cannot overwrite stored values with defaults.
- `toPublicDto` re-checks structure only; it no longer re-runs normalisers on stored values.
- The `cvx-kit/oxlint` rules recognise `k`, `kTable`, `kVariantTable` and `cvx-kit/table`.
- Relation helpers are memoised and immutable, and no longer depend on a list of audited Zod versions.
- `min`, `max` and `length` reject `NaN`, and `.int()`/`k.int()` reject `NaN` and infinities; a bare `k.number()` still accepts both.
- Async `transform` and `overwrite` callbacks fail with an issue, as async `refine` and `check` do.
- `toZod` converts defaults to Zod's `prefault`, so they run through the rest of the chain as in `k`, and `partial()` fields carry no default.
- `toJsonSchema` keeps the strongest of repeated bounds, emits extra `regex` checks as `allOf` patterns, and bounds timestamps.
- With `skipConvexValidation`, the kit validates customization-declared args before the customization's `input` runs.
- Pagination budgets (`maximumRowsRead`, `maximumBytesRead`) and search `numItems` are safe integers, and the Effect CRUD list `id` is finite, as in 0.1.x.
- An Effect builder's registered return type is the handler's value when that satisfies `returns`, and the `returns` output otherwise.
- Getter-declared `args` and `returns` (`get args() { return ... }`) are the documented default: a call builds only the function it invokes (benchmark app load 8.37 ms with properties, 6.06 ms with getters). The property form stays supported. The v2 codemod writes getters for function definitions unless the value is a plain reference; `--no-getters` opts out.
- `toZod` converts `k.id` to `z.string()` typed as the table's `Id` instead of convex-helpers' `zid`; the table name is in the new `kZodIds` registry. convex-helpers' `zodToConvex` now reads a converted id as a string.

### Removed

- `cvx-kit/zod-table`, `zodTable`, `zodVariantTable`, `zid`, `jsonSafeZid`, `zodToConvex`, `convexToZod`, `zodContract`, `effectZodApiBuilder`, `EffectZodApiBuilder`, `TableBoundary`, `VariantBoundaryOptions` and `VariantTableBoundary`.
- `bun run bench:per-call` (added in 0.2.0, written against the Zod surface). `node scripts/bench-request.mjs` covers first and warm calls.
- The 0.2.0 lazy pagination helpers built on Zod (`lazyOptional`, recipe capture). `k` pagination boundaries allocate records only and build validators on first use.

### Fixed

- The `cvx-kit-codemod-v2` bin did nothing and exited 0 when run through its package symlink; it now resolves the script path.
- `toJsonSchema` of a `.strip()` object no longer emits `additionalProperties: false` on the input side, since such an object accepts unknown keys. The output side still does.

### Performance

- Argument-less `k` scalars carry a prebuilt native validator, and `paginationOpts` builds each selected field's operator schema on first use; selection errors are still raised at the call.
- Declaring schemas records a chain and builds nothing else; native validators and parse plans are built on first use, and a function whose schemas declare no checks, defaults or transforms does no validation work of its own. On the representative benchmark app (about 30 tables, relations, contracts and auth), a function module's bundle fell from 815.8 KB to 220.6 KB, its load time from 28.34 ms to 7.97 ms and its retained heap from 9.37 MB to 2.03 MB. On one consumer app's schema graph, declaring the schemas on import fell from 23.44 ms to 4.78 ms. See the [benchmark record](https://github.com/ImRLopezAG/cvx-kit/blob/main/docs/benchmarks/validators.md).
- `cvx-kit/zod` no longer pulls classic Zod or convex-helpers into a bundle: `k` plus the interop entry fell from 237.4 KB (157.1 KB of Zod) to 152.2 KB (72.7 KB of Zod).
- The built-in `queryErrors` and `argumentErrors` contracts are marked pure, so a module that does not read one drops it (about 0.8 KB of kit code in the benchmark app's function module).

## [0.2.0] - 2026-11-26

### Breaking

- The `zod` peer range is now `^4.6.7` (was `^4.5.4`). Upgrade zod before installing this release.
- The `convex-helpers` peer range is now `>=0.1.130 <0.2.0` (was `>=0.1.127`). Earlier helper releases do not type-check against zod 4.6.7 without `skipLibCheck`.

### Added

- `argumentFailure` on `createAuthFunctions` and `createAuthReaders` chooses what is thrown when a function's zod argument schema, or the compact pagination filter guard, rejects its input. `'legacy'` (the default) keeps the `ConvexError({ ZodError: [...] })` payload unchanged. `'declared'` throws the built-in `argumentErrors` contract's `INVALID_ARGUMENTS` envelope, which `decodeFailure`, `matchFailure` and `failureOf` read after `combineErrorContracts(appErrors, argumentErrors)`. A function receives `{ source: 'arguments' | 'filter', issues }` and returns the value to throw, for example the app's own `errors.toConvexError(...)`.
- `createEffectFoundation({ argumentFailure })` applies the same policy to Effect command and query `input` validation, including direct and nested `exec`. `'legacy'` keeps the original decoder failure and endpoint projection. `'declared'` throws `INVALID_ARGUMENTS` through Effect API adapters, and a function receives `{ source: 'arguments', issues }` and returns the value to throw. The failure audit emits once per rejection without input or details. `createEffectAuthFunctions` inherits `argumentFailure` for endpoint Zod arguments through its shared auth config.
- `cvx-kit/errors` exports `argumentErrors`, `sanitizeArgumentIssues`, `ARGUMENT_ISSUE_LIMITS` and the `ArgumentIssue`, `ArgumentFailure` and `ArgumentFailurePolicy` types. Issues carry only `path`, `code` and `message`, capped at 20 issues, 32 path segments, 256-character messages and 32 KB in total. cvx-kit never adds the rejected value; messages and path segments are the schema's own, as in the legacy payload.
- `bun run bench:per-call` (`scripts/bench-per-call.mjs`) measures the first call in a fresh process and a warm loop for argument and result parsing, filtered pagination, relation pages, cursor sealing and Effect execution, with database read and policy-call counts. `--source label=root` compares source trees.

### Changed

- `relations.tables.<table>.paginationOpts(...)` still validates its selection at the call, with the same errors in the same order, but builds the `filters` schema only when it is parsed, unwrapped, converted for Convex or emitted as JSON Schema. `pageDto(...)` still reads every selected edge at the call and builds its row validator on first use. Registration, `.pick` and `.extend` build nothing. Exported Convex validators are unchanged. A module that declares many paginated operations no longer pays for the ones a request does not invoke.
- Table materialization compares native validator JSON structurally instead of building canonical strings, and module-scope helper schemas in `cvx-kit/relations` are built on first use.
- Effect command registries no longer read `contract.errors` at registration, so a thunk-declared domain contract is not forced at import.
- Internal boolean checks use zod 4.6 `.validate()` instead of `.safeParse().success`, so a rejected value no longer builds a `ZodError`.
- A paginated call without filters no longer builds the private filter grammar. Relation pages reuse child plans, scope digests and predicate classification across rows within one invocation; read counts, policy calls, error order and cursor bytes are unchanged. Cursor binding data is prepared once per pagination operation.
- The native recipe fast path for pagination DTOs now recognises zod 4.6.7. It was silently disabled on that version.
- Dependencies: convex 1.51.0, convex-helpers 0.1.137, convex-test 0.0.75, effect 4.1.6, zod 4.6.7, `@convex-dev/workflow` 0.5.0, vite-plus 1.8.0, oxlint 1.95.0, oxc-parser 0.160.0, jsdom 31.0.1, React 19.3.1. The `convex`, `effect` and `react` peer ranges are unchanged.

### Notes

- Measured on a frozen copy of a consumer app, importing one API module (local bundle, median of 11 fresh processes, against 0.1.35): 178 → 135 ms and 34.4 → 21.1 MB retained for a payments module, 243 → 184 ms and 39.9 → 34.8 MB for debts, 200 → 162 ms and 35.2 → 26.4 MB for enrollments, 131 → 119 ms and 24.0 → 19.7 MB for contacts. A search module that declares no relation pagination is unchanged (84 → 86 ms, 10.5 MB). First call of a 25-row relation page in the fixture: 29.2 → 25.5 ms; of a 100-row page: 44.5 → 39.6 ms. Other per-call scenarios are within noise. Building a filter schema now happens in the invoked function, so its first call does that work instead of the import.
- With effect 4.1, a handler failure that coincides with a failing finalizer is reported in the combined cause as a defect carrying the same value, where 4.0 reported a failure. cvx-kit's error projection already treats combined causes as unknown failures, so declared failures are classified as before.

## [0.1.35] - 2026-11-25

### Changed

- `namespace` accepts lowercase namespace segments as well as PascalCase ones. Each dot-separated segment is an identifier starting with a letter (`[A-Za-z][A-Za-z0-9]*`), so `namespace('sales', { sales_header, sales_cust_ledger_entry }, { prefixed: true })` works. `qualifiedName('sales_cust_ledger_entry')` gives `'sales.cust_ledger_entry'`, and `microsoft.inventory` strips `microsoft_inventory_`. Prefix matching stays exact and case-sensitive.

## [0.1.34] - 2026-11-25

### Added

- `namespace` recognises tables stored with the namespace prefix: `Inventory_Items` in `namespace('Inventory', …)` has the member name `Items` and the qualified name `Inventory.Items` (typed as literals). Dotted namespaces use underscores, so `Microsoft.Inventory` strips `Microsoft_Inventory_`. Keys without the prefix keep the PascalCase member name. `namespace(name, tables, { prefixed: true })` requires the prefix on every key, as a type error and a runtime error. `namespacePrefix(name)` and `memberName(table, namespace?)` expose the same mapping.

### Fixed

- `namespace` accepts any Convex table name as a key (letters, digits and underscores, such as `Inventory_Items`). It used to reject keys that were not camelCase.

## [0.1.33] - 2026-11-25

### Fixed

- The `reserved-domain-file-anatomy` oxlint rule accepts `namespace(name, { … })` from `cvx-kit/zod-table` as a table topology map in `domain/<module>/table.ts`. The members must all be table definitions, topology maps or table boundaries, so `namespace('X', { foo: 1 })` and a local function named `namespace` are still rejected.
- The `domain-file-responsibilities` oxlint rule allows `namespaceIndex(...)` from `cvx-kit/zod-table` in `domain/table.ts`, next to `createModule`.

## [0.1.32] - 2026-11-25

### Added

- `namespace(name, tables)` in `cvx-kit/zod-table` groups a module map under a declaration-level namespace (`'Inventory'`, or dotted `'Microsoft.Inventory'`). Keys stay the stored table names, so `createModule`, `defineSchema`, ids, queries and generated types are unchanged; namespaced and plain maps mix freely. Members may be `TableDefinition`s or table boundaries, and a boundary under another table's key is a type and runtime error. `namespaceIndex(...namespaces)` returns typed `qualifiedName('items')` (`'Inventory.Items'` as a literal type), `namespaceOf`, `tablesOf` and `has`; `tablesOf(ns)`, `namespaceName(ns)` and `memberName` are standalone. `createModule` and `namespaceIndex` reject duplicate namespace names and tables claimed twice.

## [0.1.31] - 2026-11-24

### Added

- Effect Command and Query executions share a request scope. An `exec` yielded inside another operation's handler or middleware joins its caller's scope automatically, with no flag in the bound context. Audit callbacks, both per-operation and registry-level, receive the scope they entered (`{ root, parent, depth }`, or `undefined` for the outermost operation) as a third argument. An `exec` started through `Effect.runPromise` inside a handler opens a new scope, so yield nested executions instead.

- `createEffectFoundation({ auditFailure })` reports failed Effect commands and queries to a host-free sink: kind, operation, classification, declared error code (or `UNKNOWN_FAILURE`), whether it was declared, the request root and depth. Declared `details` and the decoded `input` appear only through the optional `details` and `input` redactors. Raw input, defect messages and stacks are never included. Each failure is reported once per request, by the innermost operation that failed, so codes from nested registries survive, and a nested failure that a parent recovers from is still reported. `auditFailure.errors` (for example a `combineErrorContracts` result) projects failures that the registry's own contract does not recognize, including those of inline registries. A failed mutation rolls back its writes, so the sink logs, and log streams carry entries to external telemetry. Queries and mutations have no `fetch`. Sink errors never change the original failure. `FailureAuditEntry`, `FailureAuditOptions`, `RequestScope` and `NestedAuditMode` are exported from `cvx-kit/effect`.
- `effectErrors(contract)` in `cvx-kit/effect` returns `fail` and `attempt` bound to a declared error contract. `return yield* fail('NOT_FOUND')` fails with the typed declared error, and `details` may be omitted only for codes that declare no detail fields. `attempt(() => work())` runs sync or async work: a thrown declared error of that contract, or a `ConvexError` carrying one of its declared envelopes (for example from `ctx.runMutation`), lands in the typed failure channel, so `Effect.catchTag('DeclaredError', ...)` recovers it. Any other throw stays a defect. Contracted Command and Query registries whose `errors` is a `defineErrorContract` result also receive `fail` and `attempt` on the operations factory (`operations: ({ command, fail, attempt }) => ...`). Combined contracts cannot create errors and do not get them.
- `foundation.Action({ context, operations: ({ action }) => ... })` runs Convex actions through the same lifecycle as commands: schema-decoded input and result, context injection, default and per-operation guards, middleware, observability, failure audit and request scope. Handlers call queries and mutations through `ctx.runQuery`/`ctx.runMutation` with typed references, and `attempt` turns their declared `ConvexError`s into typed failures. `classification` is optional (default `'action'`), and so is `audit`, per operation or per registry. Audit entries go to the new `writeActionAudit(host, entry)` Foundation option (typically through `ctx.runMutation`); an audited action without that writer fails with `ActionAuditWriterError` before its handler runs. A completed action whose audit write fails still returns its result and reports `ACTION_AUDIT_WRITE_FAILED` to `auditFailure` (or logs a payload-free `action.audit_write_failed` line when no sink is configured), so callers never retry work that already happened. An interrupted audit write still interrupts the action. Actions have no `prepare`, `replayResult`, `permission` or `expose`.
- Domain contracts accept an `actions` section (`defineDomainContract({ errors, actions })`). `foundation.Action({ contract, context, audit?, operations: ({ action, fail, attempt }) => ... })` implements it with exact-key enforcement, `action.<name>(...)`/`action.handler(...)` helpers, an optional registry-level `audit` callback, and getter-declared actions that bind on first execution.

### Changed

- `projectErrorCause` (and therefore the Effect API adapters' `errors` projection) projects a single defect that the contract trusts, such as a declared error thrown with `throw errors.create(...)` inside `Effect.gen`, to its `DeclaredFailure` instead of `UnknownFailure`. Look-alike objects and other defects still project to `UnknownFailure`.
- **Breaking (behavior):** by default (`nestedAudit: 'fold'`), an Effect command nested under an operation that declares an audit callback no longer runs its own audit callback or writes an audit entry. The outermost auditing operation's entry stands for the request. A nested command without an auditing ancestor, such as one inside a query, still audits. Actions never fold, because their `ctx.runMutation` writes commit independently. Set `createEffectFoundation({ nestedAudit: 'separate' })` to keep one audit entry per nested operation.

## [0.1.30] - 2026-11-11

### Added

- `createAuthReaders(config)` in `cvx-kit/auth` returns the query and action constructors (with `include` and `authenticatedUser`) from a config that has no triggers, `wrapDB` or mutation builders. It shares `createAuthFunctions`' implementation and offers no mutation constructors. `AuthFunctionsConfig` is now `AuthReadersConfig` plus the mutation-side fields, so one base config feeds both. Build query modules from readers so their import graph excludes the trigger registry. The Effect auth constructors (`createEffectAuthFunctions`) have no reader variant yet.
- Kit function builders accept `get args()` / `get returns()` and read them only when Convex exports the function's metadata or the function is first called.
- Domain contracts accept getter-declared operations, and getter-declared `input`/`result`/`replayResult`/`wire`. Each is memoized, and registries bind a getter-declared operation on its first execution with the same checks. For Effect registries, `checkArchitecture({ registries })` still binds and validates every operation. Promise-foundation registries cannot be forced, so their getter-declared operations report configuration errors on first execution.
- `scripts/bench-app-load.mjs` (per-request module-load benchmark with a budget check, `bun run bench:app-load`) and `scripts/bench-consumer.mjs` (measures a consumer's Convex entries against a local dist). See `docs/benchmarks/module-load.md`, which also records which entry points reach `effect` (only `cvx-kit/effect`; xstate, evlog and mime are not cvx-kit dependencies, and packaging is unchanged).

### Changed

- Registering a function no longer converts its args or returns to Convex validators or builds its compact filter boundary. The definition handed to Convex exposes them lazily, and the handler builds its parse state on first call. Validation is unchanged. **Timing:** these conversion errors now surface when `exportArgs`/`exportReturns` run (at push, and on every convex-test call) instead of at import: a zod type Convex cannot represent, a conflict between a function's args and its constructor's input args (`Cannot intersect validators with different kinds`), and compact filter-boundary errors. Data-declared non-object zod args and `skipConvexValidation` with custom input args still throw at registration; getter-declared args report them at export or first call. A definition with both non-object zod args and an unconvertible `returns` now reports the args error.
- The first `paginationOpts(...)` call for a selection, and the first plain `pageDto(...)`, use their fresh build instead of capturing and restoring a recipe. A repeated selection captures, and later calls restore. Results are identical across calls.
- The Effect API adapters (`effectApiBuilder`, `effectZodApiBuilder` and the Effect auth constructors) forward accessors instead of spreading the definition, so getter-declared args stay unread.

## [0.1.29] - 2026-11-08

### Added

- `serviceQuery(principal)` and `serviceMutation(principal)` on `createAuthFunctions` and `createEffectAuthFunctions`: internal constructors that run as a host-derived service principal with tenancy and `security.rules` fully applied. Service queries register their secured reader with the query engine in `trusted` scope; service mutations run triggers and then the same secured writer as `authMutation`. Extra fields returned by the principal factory reach `ctx` and `security.rules` (`SecurityBundle<Role>`); an extra named like a native context handle (`db`, `auth`, ...) is rejected. No identity lookup or membership verification runs; `system*` behaviour is unchanged.

### Fixed

- Relation registration no longer rejects Zod's built-in `default`/`prefault` accessors when a bundle contains two Zod copies (esbuild renames the module namespace, e.g. `util_exports2.shallowClone`). Convex module analysis of consumers that resolve `cvx-kit` through a linked checkout failed with `Unsupported stored schema accessor`.

## [0.1.28] - 2026-11-07

### Added

- Support Convex component schemas, table indexes, local infrastructure and mutation builders in the Oxlint plugin. Discover component roots from `defineComponent`, conventional layouts or explicit `componentDirs`.
- Expose `triggerContext(triggers)` to run component-local triggers, including timestamps and tenant ownership, through public and internal custom mutation builders.
- Allow explicit additional domain public files with `domainPublicFiles`, preserving the strict default import surface.
- Recognize component roots, sibling tests and local runtime cycles in architecture checks without exempting neighboring host source.
- Document component authoring across query engines, relations, DTOs, operations, contracts, audit, tenancy, typed host clients and nested tests. Registered-component proofs cover local query authority, timestamp and audit rollback, typed errors and nested workflow dispatch.

### Fixed

- Accept installed workspace package dependencies and builder aliases at component boundaries.
- Clarify component row contracts: native IDs remain supported, while required timestamp results must explicitly validate optional storage fields.

## [0.1.27] - 2026-11-02

### Fixed

- Reduce eager table/contract import cost by constructing strict document and write boundaries directly, sharing private declaration-time field selections while retaining independent public field maps.
- Avoid constructing unused native pagination arguments for relation page results. On audited Zod constructor environments, return the first unselected ordinary page after capturing its isolated private recipe; subsequent calls still materialize independent validators. Variant rows, selected relations, field groups, configured hooks, changed memoizers and unknown peer versions retain reconstruction.

### Added

- An eager consumer benchmark with 87 indexed tables, cross-table document IDs, DTO/command/update/tool composition, native schema maps and 30 distinct domain contracts consumed at import. Compare 0.1.25, 0.1.26 and the candidate in interleaved fresh Node processes, alongside the existing deferred fixture, with full sample distributions and output snapshots. See `docs/benchmarks/module-load.md` for the local results and reproduction steps.

## [0.1.26] - 2026-11-02

### Changed

- Build ordinary and variant table document, insert, update, command, public DTO and tool schemas on first access, retaining stable property identities and independent field maps. Reuse relation page/filter recipes while preserving independent public validators. Scalar pagination continues to observe changes to its mutable source schema on each call.
- Build and validate Effect Query and Command operation registries when their first execution runs. Configuration failures remain cached and surface as execution defects; exposing an operation also validates its registry.

### Added

- `defineDomainContract(() => ({ ... }))` defers contract construction until the first property read, enumeration or other object operation, with the same inferred operation types and literal-key checks as object declarations. Both forms satisfy the domain architecture lint rules.
- `checkArchitecture({ registries: [queries, commands] })` validates deferred Effect registries without executing handlers.
- An import benchmark covering 87 tables, 30 pagination/page contract pairs and 20 Effect registries: `node scripts/bench-relations.mjs . 11 module-load`.

## [0.1.25] - 2026-10-30

### Changed

- Defer each relation table's registration work to its first use: schema helpers, an engine read, or a selected relation that reaches it, including a through relation's junction. `defineRelations` now checks only table names, native table ownership and relation declaration structure, so a registry module costs little to import when a function uses few of its tables. Variant tables still run native table preflight at registration.
- Check each relation edge's field types and supporting indexes on its first read; an edge's targets need only their stored side for that check.
- Compute the registry identity, metadata snapshots and stream schema on demand. Their values are unchanged.
- Bind engine cursors to the registry identity of what their query reads: its table, the relation path to it, and the relations its selection, field groups and relation filters walk, with the tables those relations touch. A page request now materializes only those tables, and a registry change outside that scope no longer invalidates the cursor. Cursors issued by 0.1.24 and earlier still resume: an engine computes the full identity once, on the first such cursor, and continuations are resealed under the scoped binding.
- Build the engine's filter validator per input: relation predicates, and the relation tables they reach, are built only for the relations a filter names. Validation results are unchanged; a page request no longer pays for every relation four levels deep. An invalid edge that the engine filters on now throws when a filter first names it.
- Invalid tables and edges now throw on first use instead of at registration, and later changes to a table's source definitions are ignored only after its first use.

### Added

- `verifyRelations(relations)` runs every deferred registration check now, so a test can fail CI on an invalid registry.
- A registration benchmark: `node scripts/bench-relations.mjs`.

## [0.1.24] - 2026-10-28

### Changed

- Defer eligible private relation DTO reconstruction until projection while keeping registration validation, schema capture and registry identity eager. Public helper schemas remain independent.
- Reduce constructor-dispatch work for ordinary schemas on the audited Zod versions, retaining the original scan for other versions and custom readers. Side-effecting Proxies around Zod internals are unsupported.
- Capture each registered function's top-level argument fields once and reuse its argument object schema; parsing, defaults, refinements and transforms still run on every invocation.

### Added

- Pass the already resolved identity as the second `getAuthUser` argument so consumers can avoid another identity lookup. Existing one-argument callbacks remain supported.

## [0.1.23] - 2026-10-26

### Added

- Opt into compact pagination filter validators with `paginationOpts(selection, { validator: 'compact' })` on tables and relations, retaining precise common generated types and full semantic validation before customization or handlers.
- Export `PaginationFiltersInput` from `cvx-kit/relations` for full-depth filter literals.

### Changed

- Reduce the three-field/13-literal fixture's registered validator by 29.22 times and generated argument declarations by 35.85 times. Native ID-heavy paths retain their validators and can limit compression; default conversion is unchanged.

## [0.1.22] - 2026-10-26

### Added

- Compose domain error contracts with `combineErrorContracts`, preserving the union of declared codes and details.
- Construct validated transport payloads with contract `envelope` and `toConvexError`, and select declared failures with `failureOf` and `isFailure`.
- Opt into original-error React boundaries with `usePaginatedList({ onFailure: 'throw' })`, or inspect the raw `error` alongside the decoded failure.

### Fixed

- Decode one bounded JSON envelope from serialized `ConvexError.data`, using the same strict validation as object payloads.
- Preserve invalid-cursor recovery before list failure throwing, with subscription cleanup and fresh-epoch boundary retry.

## [0.1.21] - 2026-10-25

### Added

- Add typed index ordering, native range bounds, and ordered multi-value traversal for authorized queries.
- Expose page completeness and safe budget continuation, policy-gated field groups, and managed public cursor codecs.
- Export browser-safe filter contracts, typed client failures, React mutation commands, reactive paginated lists, and conservative optimistic list updates.
- Support root native full-text search with authenticated continuation, authorized relation expansion, and React search journals. Search targets and scan limits are admission thresholds; reactive native windows can exceed them.
- Document the new APIs and their authorization, budget, and continuation contracts in the repository-hosted AI skill.

### Changed

- Update development compatibility to Convex 1.48.0 and convex-helpers 0.1.129 while retaining packed consumer coverage for the advertised minimum peers.

## [0.1.20] - 2026-10-18

### Changed

- Reduce repeated schema integrity checks, filter parsing, and DTO construction work during relational queries while preserving existing public APIs.
- Reuse variant field lists and DTO reconstruction factories while validating current row values on every call and returning independent mutable schemas.

### Fixed

- Preserve supported Zod constructor compatibility, live refinement callbacks, native ID validation, and schema mutation isolation across optimized query boundaries.

## [0.1.19] - 2026-10-13

### Added

- Export `createTable` to reuse a shared object of Zod field validators across ordinary table declarations, preserving `zodTable` boundaries, native IDs, field masks, tools, and index inference.
- Reject table-specific declarations that duplicate shared field names, with runtime checks and static rejection for known keys.
- Document reusable table fields in the README and repository-hosted skill.

## [0.1.18] - 2026-10-13

### Added

- Select registered native-ID union members with `forTable` for direct forward and indexed inverse relations, including generated variant-table targets.
- Preserve authorization, bounded pagination, and cursor identity for selected ID members without changing the stored union or root DTO.
- Document native-ID relation wiring, independent link authorization, and additive migration with resumable backfill and rollback.

### Fixed

- Preserve explicit timestamp validators and ordinary boundary masks in `zodVariantTable` when `timestamps: false`, including required server-owned ledger timestamps.
- Reuse equivalent bounded filter grammar and schema nodes so dense relation graphs fit within Convex's module memory limit.

### Compatibility

- Branch-scoped field narrowing and narrowed junction joins are explicitly unsupported in this release; existing branch and junction declarations remain supported.
- Relation declaration changes invalidate prior cursors and require pagination to restart.

## [0.1.17] - 2026-10-13

### Added

- Register generated variant boundaries in relations and the shared authorized query engine, retaining discriminated DTOs and native branded IDs.
- Declare guarded branch references and branch filter allowlists/predicates for direct, nested, and junction relationships.
- Verify installed variant query consumers with sanctioned Convex codegen and native write/read flows.

### Changed

- Run bounded integration tests in CI while retaining the full local unit and relational stress suites.
- Run packed component smoke jobs independently of the main verification job.
- Document complete variant-table registration, authenticated queries, filtering, and continuation in the repository skill.

## [0.1.16] - 2026-10-13

### Added

- Opt-in `zodVariantTable` command, insert, update, public DTO, and tool boundaries with per-variant masks, native storage IDs, and strict discriminators.
- Repository-hosted `cvx-kit` agent skill, installable from GitHub through the skills CLI, with task-specific access to the full documentation.

### Changed

- Keep documentation in `skills/cvx-kit/references` and ship only the README as npm documentation.
- Verify portable skill references in CI and before publication; remove obsolete planning and explainer artifacts.

### Fixed

- Preserve optional/nullable refinements in derived tool inputs and reject bigint command literals before JSON Schema generation.

## [0.1.15] - 2026-10-11

### Added

- Declare a global query engine with only `createQueryEngine({ schema, relations })`.
- Load cursor secrets internally from server environment configuration on first pagination.
- Configure optional engine overrides in a separate second argument, while preserving existing declarations.

### Changed

- Document global engine setup, server cursor secrets, and the purpose of advanced options.
- Publish releases after successful CI for the exact main commit, without repeating tests in the release workflow.

## [0.1.14] - 2026-10-11

### Added

- Typed relational queries with scalar and relationship filters, conditional indexes, global ascending or descending order, and bounded stream pagination.
- Explicit relationship declarations for direct, self, and junction relationships, with paginated child continuations.
- Managed query authorization, shared read budgets, and encrypted cursors bound to the query, principal, tenant, and parent relationship.
- Table DTO options for validated IDs and extensions, including `toPublicDto(row, true)`, plus native-derived `paginationOpts` and page DTO helpers.
- Oxlint enforcement for manual ID projections, copied pagination contracts, and unsafe relational query boundaries.
- Dedicated querying documentation and updated table and rule documentation in `src/docs`.

### Fixed

- Preserve shared validator graphs during native auth registration to avoid repeated validator expansion.

### Verified

- Source, type, rule, and packed-consumer checks; 308 independently audited relational stress sequences across installed and minimum peer versions.
- 33 HTTP responses exercised encrypted cursor pagination and rejection paths on a local Convex backend. Hosted production performance remains unmeasured.

## [0.1.13] - 2026-10-10

### Added

- Implement contracted operations with `command.handler(handler, options?)` and
  `query.handler(handler, options?)` in both Promise and Effect registries.
- Infer each handler's input and result from its operation object key, without
  repeating the operation name; preserve existing named helpers.

### Verified

- Cover contract binding, validation, audits, and handler inference with 684
  runtime tests and strict type fixtures.
- Compile the documentation examples and test packed npm/Bun consumers with
  and without Effect.

## [0.1.12] - 2026-10-10

### Added

- Declare optional domain contracts with root errors, command classification,
  and exact command/query implementation keys in both Effect and Promise registries (#26).
- Share a registry-level command audit default with per-operation overrides,
  preserving replay bypass, schema inference, and transactional rollback.
- Use `createFoundation` for typed Promise registries without installing Effect.
- Enforce reserved domain file declarations through the packaged Oxlint plugin,
  including constructor provenance and declarative contract ownership.
- Document both contract APIs with packed-compiled examples and audit guidance.

### Verified

- Cover native validation, error projection, rollback, audit selection, agent tools,
  workflow integration, and npm/Bun consumers with and without Effect.
- Pass 680 runtime tests, 340 lint-rule tests, and both packed-component CI smoke tests.

## [0.1.11] - 2026-10-09

### Added

- Configure shared post-auth Effect services and command/query handles once across
  all auth, role, admin, and system constructors with `createEffectAuthFunctions` (#24).
- Keep query, mutation, action, and internal system capabilities separately typed
  and configured; preserve secured database wrapping and live action membership.
- Document the shared application factory with packed-compiled examples and
  constructor capability guidance for coding agents.

### Verified

- Cover denied authentication, roles and membership, request-local scopes, context
  collisions, nested command auditing, and registered mutation rollback.
- Preserve packed native auth context compatibility on Convex 1.45 and 1.46.

## [0.1.10] - 2026-10-09

### Fixed

- Preserve native Convex context types in auth, role, admin, and system function
  constructors so secured handlers bind directly to Effect registries (#22).
- Install Standard Schema types explicitly so native contract input and output
  inference works in clean installations.

### Changed

- Update package dependencies and migrate the development toolchain to Vite+ 1.1.
- Require Convex 1.46 or newer and convex-helpers 0.1.127 or newer (below 0.2.0),
  matching workflow 0.4.10.

## [0.1.7] - 2026-10-07

### Added

- Add optional Effect 4 command and query registries with cohesive ordinary,
  Promise, generator, and function handlers, injected services, and scoped API
  execution through native and custom Convex builders.
- Add asynchronous operation contracts, explicit schema adapters, and checked
  transport for declared safe errors.
- Add injectable audited Effect CRUD, host-owned transactional idempotency
  receipts, native durable workflow bindings, and selected domain operation tools.
- Document server-side declaration, composition, API consumption, receipts,
  workflows, and tools with compile-checked public-package examples.

### Fixed

- Preserve native validators, trusted authorization, RLS, triggers, audit, and
  rollback across API, workflow, and tool integrations.
- Reconcile late workflow outcomes without allowing stale generations or late
  completion to overwrite canceled runs.
- Validate retained receipt versions before fingerprints and replay, and require
  current authorization before disclosing replayed results.

## [0.1.6] - 2026-09-19

### Added

- Add five opt-in consumer Oxlint rules for project structure, root wiring,
  application orchestration, internal function ownership, and domain file
  responsibilities. The packaged plugin now includes 20 rules.
- Check colocated test presence, runtime import cycles, and shared-code ownership.
  Export `checkArchitecture` for standalone checks without copying architecture
  test suites into applications. These static checks do not replace behavior tests.

### Fixed

- Resolve tsconfig aliases when checking consumer import boundaries and reject
  migration dependencies from application code.
- Enforce documented ownership of domain implementations, table aggregation,
  query side effects, and component boundaries.

## [0.1.5] - 2026-09-18

### Fixed

- Correct `cvx-kit/oxlint` to enforce the documented consumer `convex/` layout
  rather than this repository's `src/` layout. Keep the six library-authoring
  rules in repository tooling and publish 15 consumer rules, with coverage for
  domain boundaries, auth builders, thin adapters, facade ownership, table
  placement, vocabularies, bounded read syntax, and trigger-owned timestamps.
- Replace consumer `entryPoints`/`packageName` options with `convexDir`; document
  migration, allowed exceptions, and the checks that still need runtime tests.
  Validate the packaged plugin against consumer fixtures installed by npm and Bun.

## [0.1.4] - 2026-09-18

### Added

- Publish the TypeScript Oxlint plugin as `cvx-kit/oxlint`, with six rules for
  component isolation, environment access, schema placement, public facades,
  API ordering, and named private helpers. Consumer entry points and package
  self-import boundaries are configurable.
- Enforce all 15 generic anti-slop rules in the repository and verify the
  published plugin through fresh npm and Bun installations in CI.

### Changed

- Replace cast-heavy command, CRUD, tenancy, auth, webhook, and tool boundaries
  with schema-derived types and validation. Preserve distinct agent-tool result
  types and validate the emitted declarations in packed consumers.
- Tighten TypeScript contracts for query middleware, include transforms, audit
  metadata, and webhook targets. See `docs/upgrading.md` for migration details.
- Format owned source, tests, scripts, and documentation consistently.

## [0.1.3] - 2026-09-06

### Fixed

- Fix Convex ID validation across package boundaries by sharing `convex-helpers`
  as a peer dependency. Export `zid`, `zodToConvex`, and `convexToZod` from
  `cvx-kit/zod-table`; verify differing compatible host versions under npm and Bun (#10).
- Add `Command.withContext<Context, Extension>()` for schema-inferred guards,
  audit callbacks, operation middleware, and correlated registry middleware (#11).
- Add invocation-local `prepare` hooks with authorized, validated replay and
  completion after audit, inside observation. Durable storage remains host-owned (#12).
- Accept concrete and generic `convex-test` backends directly in registration helpers (#13).
- Parse command results once after middleware; handler and middleware result types
  describe schema inputs, while audit, completion, and executor results describe outputs.
- Accept raw command schema inputs at executor call sites while inferring parsed
  outputs for callbacks; reject incompatible typed host contexts and registry middleware.
- See `docs/upgrading.md` for helper peer installation and transformed-result migration.

## [0.1.2] - 2026-08-21

### Added

- `resolveOrganization` hook on `createAuthFunctions`: identity providers
  whose tokens carry no org claims (custom credentials, magic codes,
  memberships in app tables) can resolve organization and role from the
  database. When configured, the hook overrides claim-based resolution and
  fails closed — `null` or an error rejects with `FORBIDDEN`; its `roleSlug`
  still passes `mapRole`, tenancy derives from the hook's organization, and
  `verifyMembership` for actions is unchanged. Hook-less configurations are
  unaffected. ([#8](https://github.com/ImRLopezAG/cvx-kit/issues/8))

## [0.1.1] - 2026-08-17

### Fixed

- Package Convex component schemas exclusively as discoverable `schema.js` and
  `schema.d.ts` files. This restores the approvals tables and the
  `approvalDecisions.by_runId_and_decidedAt` and
  `approvalDecisions.by_runId_and_stepKey_and_actor_actorRef` indexes without
  consumer `patchedDependencies` workarounds or canonicalization conflicts.
- Keep compiled component imports aligned with the discoverable `schema.js`
  filename when runtime functions use the schema directly.
- Include `stepKey` in the public approval callback evidence contract and
  export canonical Zod and Convex callback validators for strict consumers.
- Use component-safe cursor pagination for approval request lists instead of
  Convex's app-only built-in `.paginate()` implementation.

### Added

- Packed-tarball content checks and clean anonymous-deployment smoke tests for
  every bundled component under both Bun and npm installation.
- `components.approvals.health.check`, which verifies the approvals schema
  version and required decision indexes with an actionable failure diagnostic.
- Supported Convex, Zod, Bun, Node.js, and npm versions plus an approvals
  packaging migration note.
- Packed callback and paginated-list smoke coverage through real host wrappers.

## [0.1.0] - 2026-08-14

The big one: the full helper surface, in one release.

### Added

- **Pagination bridge** — `paginated(dto)` boundary schemas
  (`cvx-kit/zod-table`) and an `include(...).paginate(opts, transform?)`
  terminal (`cvx-kit/auth`): cursor pagination bounded by the same maxRows
  policy as `execute`. Under row-level security, pages may be shorter than
  `numItems` (filtered rows); cursors remain correct.
- **CRUD command factory** — `createCrudCommands` (`cvx-kit/crud`):
  create/update/archive operations generated from a zodTable, fully inside
  the audited command pipeline; soft-delete only; `enrich` is required for
  tenantTables (fails fast with `CRUD_ENRICH_REQUIRED`).
- **State-machine helper** — `createStateMachine` (`cvx-kit/state-machine`):
  typed transition legality from constants tuples; `assert` throws
  `INVALID_TRANSITION` via the injected ErrorFactory, dropping straight into
  command guards.
- **Rate-limit middleware** — `rateLimit` (`cvx-kit/middleware`): the first
  packaged middleware, over an injected `@convex-dev/rate-limiter` instance
  (structural typing — zero new kit dependencies). Keyed by `ctx.tenant` by
  default; a missing key is a configuration error
  (`RATE_LIMIT_KEY_MISSING`), never a silent shared bucket.
- **Webhook boundary** — `createWebhookBoundary`, `recordWebhookEvent`,
  `webhookEventsTable` (`cvx-kit/webhooks`): raw-body signature verification
  (fail closed), natural-key dedup transactional inside the target internal
  mutation, host-owned dedup table.
- **Agent tool generator** — `createAgentTools` (`cvx-kit/agent-tools`):
  tool records from the table tool masks, shape-compatible with
  `@convex-dev/agent`'s `createTool` without depending on it; mutation
  handlers route through command executors so agents get audited commands.
- **Typed middleware context** — `Command.middleware<Ctx, Extension>` /
  `Query.middleware<Ctx, Extension>`: `next({ context })` is typed against
  the declared extension; registries and operations accept typed middleware
  without casts (`AnyCommandMiddleware`/`AnyQueryMiddleware` variance seam).
- **Upgrade guide** — `docs/upgrading.md` ships in the package: old way →
  new way per feature for consumers on 0.0.x.

### Changed

- `tools.update` / `tools.id` masks now use `jsonSafeZid` instead of `zid`,
  so ids present as plain strings in generated JSON schemas (compile-time
  `Id<...>` types preserved).
- Release workflow now creates a GitHub Release with this file's section as
  notes, and action pins are updated past the Node 20 deprecation.

## [0.0.8] - 2026-08-14

- Composable next()-based middleware for Command and Query kernels, inside
  pipeline invariants (registry-wide + per-operation, context enrichment,
  result re-parse).

## [0.0.7] - 2026-08-14

- `systemQuery` constructor: internal, include-equipped, RLS-unwrapped.
  BREAKING: `createAuthFunctions` config requires the `internalQuery` builder.

## [0.0.6] - 2026-08-14

- Materialized `convex.config.js` bridges (Convex CLI discovers components by
  that literal filename). BREAKING: mount via
  `cvx-kit/components/<name>/convex.config`; client facades no longer
  default-export the component config.

## [0.0.5] - 2026-08-14

- BREAKING: the Foundation facade is the only runtime surface — kernel
  classes and execution utilities destructure from the instance.

## [0.0.4] - 2026-08-14

- Tarball ships only `dist`, `docs`, and the source test helper
  (`.npmignore`); `cvx-kit/test` registers compiled dist modules.

## [0.0.3] - 2026-08-14

- Opt-in tenancy and security controls: `tenantTable`, `createModule`,
  `security` config on `createAuthFunctions` (role rules + tenant RLS),
  `ctx.tenant`, `cvx-kit/tenancy`, `tenantOwnership` trigger. Command
  guards, permission checks, and the aggregate allowlist.

## [0.0.2] - 2026-08-13

- Shipped package documentation (architecture, conventions, migration,
  llms) at `docs/`; opinionated timestamps on every table; single-path
  component mounts.

## [0.0.1] - 2026-08-13

- Initial release: foundation + approvals components, zod-table boundaries,
  auth constructors, triggers, audited command protocol.
