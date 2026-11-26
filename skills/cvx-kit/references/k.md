# `k` — validators on native Convex validators

`k` is cvx-kit's schema layer. Every `k` schema carries a plain native Convex validator, and that validator is what Convex receives for function args, function returns and table definitions. The kit runs checks, defaults, normalisers, refinements and transforms itself, only where a schema declares them.

Import it from the package root or its own entry:

```ts
import { k } from 'cvx-kit' // or 'cvx-kit/k'
```

Tables built from `k` fields are covered in [table](table.md). Moving an app from Zod is covered in [migration-v2](migration-v2.md).

## Example

```ts
import { k } from 'cvx-kit/k'

const STATUSES = ['draft', 'published'] as const

export const documentInput = k
	.object({
		title: k.string().trim().min(1).max(200),
		ownerId: k.id('users'),
		status: k.enum(STATUSES).default('draft'),
		tags: k.array(k.string().toLowerCase()).max(10).optional(),
		dueOn: k.isoDate().nullable().optional(),
		startsAt: k.number().int().min(0),
		endsAt: k.number().int().min(0),
	})
	.refine((value) => value.startsAt <= value.endsAt, {
		message: 'endsAt must not be before startsAt',
		path: ['endsAt'],
	})

export type DocumentInput = k.input<typeof documentInput> // status optional, ownerId is Id<'users'>
export type Document = k.infer<typeof documentInput> // status required
```

## Factories

| Factory                                  | Parses                                                                      | Native validator                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `k.string()`                             | string                                                                      | `v.string()`                                                        |
| `k.number()`                             | any number, including `NaN` and `±Infinity` (as `v.number()`)               | `v.number()`                                                        |
| `k.int()`                                | a number for which `Number.isInteger` holds                                 | `v.number()`                                                        |
| `k.int64()`                              | bigint                                                                      | `v.int64()`                                                         |
| `k.boolean()`                            | boolean                                                                     | `v.boolean()`                                                       |
| `k.null()`                               | `null`                                                                      | `v.null()`                                                          |
| `k.bytes()`                              | `ArrayBuffer`                                                               | `v.bytes()`                                                         |
| `k.any()`                                | any value except `undefined`                                                | `v.any()`                                                           |
| `k.json()`                               | a JSON-compatible value, checked throughout (finite numbers, plain objects) | union of string, number, boolean, null, array of any, record of any |
| `k.literal(value)`                       | one string, number, bigint or boolean                                       | `v.literal(value)`                                                  |
| `k.enum(values)`                         | one of a non-empty tuple of strings; `.options` returns the tuple           | union of literals (a one-value enum is a one-member union)          |
| `k.id('table')`                          | a string; typed `Id<'table'>` on input and output                           | `v.id('table')`                                                     |
| `k.array(element)`                       | an array                                                                    | `v.array(...)`                                                      |
| `k.object(fields)`                       | a plain object with exactly these keys                                      | `v.object(...)`                                                     |
| `k.record(key, value)`                   | a plain object; `key` is a string schema; see [Records](#records)           | `v.record(...)`                                                     |
| `k.union([a, b, ...])`                   | the first member that parses (two or more members)                          | `v.union(...)`                                                      |
| `k.discriminatedUnion(key, [a, b, ...])` | the option whose `key` field (a literal or enum) matches; values unique     | `v.union(...)` of the objects                                       |
| `k.isoDate()`                            | `YYYY-MM-DD` naming a real calendar day                                     | `v.string()`                                                        |
| `k.isoDateTime()`                        | ISO 8601 date-time with seconds and a `Z` or `±HH:MM` offset                | `v.string()`                                                        |
| `k.timestamp()`                          | integer milliseconds from 1970-01-01 through the end of 9999 (UTC)          | `v.number()`                                                        |

Argument-less factories return one shared, immutable root, so `k.string()` allocates nothing.

`k.number()` accepts `NaN` and infinities because native `v.number()` does. `min`, `max` and `length` reject `NaN`, and `.int()` and `k.int()` reject both `NaN` and infinities. Add a check when an unbounded number must be finite:

```ts
const amount = k.number().refine(Number.isFinite, 'Expected a finite number')
```

### Records

After the key schema has run (including normalisers such as `trim`), each key must also satisfy Convex's record-key rule: non-empty, at most 1024 characters, printable ASCII, and not starting with `$` or `_`. A key that breaks the rule fails with an `invalid_format` issue at that key's path. Parse writes every output key as an own property, so a key such as `__proto__` cannot reach a prototype.

### Discriminated unions

Each discriminator value must belong to one option. Two options that share a value (two equal literals, or an enum that overlaps another option's literal) make the schema throw when it is first used, for example on the first `parse` or the first call of a function that declares it. Declaring it does not throw.

### Immutability

Schemas are immutable, and so are the containers they hold:

- The arrays and objects passed to `k.enum`, `k.union`, `k.discriminatedUnion` and `k.record`, and the options object (and its `path`) passed to `refine`, are frozen at declaration.
- An object's field map is frozen the first time `.shape` is read, including the field map of a `pick`, `omit`, `extend` or `partial` result.

A shared array or field object therefore becomes read-only: a later `push` or property assignment throws in strict mode. Spreading it (`[...STATUSES, 'archived']`, `{ ...fields, extra }`) and `.extend(...)` still work. Do not mutate a field object after passing it to `k.object`.

## Chain methods

Every method returns a new immutable schema. Reusing a schema in several places is safe.

| Method                                          | On                          | Effect                                                                       |
| ----------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `.optional()`                                   | all                         | may be `undefined`; natively `v.optional(...)`                               |
| `.nullable()`                                   | all                         | may be `null`; natively `v.union(T, v.null())`                               |
| `.default(value)`                               | all                         | fills `value` when the input is `undefined`; see [Defaults](#defaults)       |
| `.min(n, message?)` / `.max(n, message?)`       | string, number, array       | inclusive length or value bound                                              |
| `.length(n, message?)`                          | string, array               | exact length                                                                 |
| `.regex(pattern, message?)`                     | string                      | the pattern must match                                                       |
| `.int(message?)`                                | number                      | `Number.isInteger` must hold                                                 |
| `.trim()` / `.toLowerCase()` / `.toUpperCase()` | string                      | type-preserving normalisers                                                  |
| `.overwrite(fn)`                                | all                         | a type-preserving normaliser: `fn(value)` replaces the value                 |
| `.refine(fn, message?)`                         | all                         | `fn(value)` must return `true`; `message` is a string or `{ message, path }` |
| `.check((value, ctx) => …)`                     | all                         | adds any number of issues with `ctx.addIssue({ message, path?, code? })`     |
| `.transform(fn)`                                | all                         | a type-changing step; see [Transforms](#transforms)                          |
| `.pipe(schema)`                                 | all                         | parse this schema's output with `schema`; a transform kind                   |
| `.describe(text)`                               | all                         | a description for JSON Schema and tooling; `.description` reads it           |
| `.unwrap()`                                     | optional, nullable, default | the schema below the wrapper                                                 |
| `.strip()`                                      | object                      | parse removes unknown keys instead of reporting them                         |

Checks and normalisers run in declaration order after the structure is valid: normalisers first, then checks. Messages are optional; each check has a default message.

Refinements, checks, normalisers and transforms are synchronous. A `refine` callback that returns a promise fails with an `Invalid input` issue, a `check` that returns one adds `A check must be synchronous`, and a `transform` or `overwrite` that returns one fails with a `custom` issue saying async callbacks are not supported. Do asynchronous work in the handler.

```ts
const range = k.object({ from: k.int(), to: k.int() }).check((value, ctx) => {
	if (value.from > value.to) ctx.addIssue({ path: ['to'], message: 'to must be >= from' })
	if (value.to - value.from > 1000) ctx.addIssue({ message: 'range too large' })
})
```

## Objects

`k.object(fields)` is always strict: parse reports each unknown key as an `unrecognized_key` issue, and the native validator is a closed `v.object`. Convex has no open object, so there is no loose object or catchall. Use `.strip()` when parse should drop unknown keys (the native validator stays closed), or a `k.record(...)` field for open-ended keys.

| Operation                    | Result                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `.shape`                     | the field map; reusing a field keeps every check, default and normaliser declared on it           |
| `.pick('a', 'b')`            | a new object with those fields                                                                    |
| `.omit('a', 'b')`            | a new object without those fields                                                                 |
| `.extend({ c: k.string() })` | a new object with added or replaced fields                                                        |
| `.partial()`                 | every field optional; a defaulted field becomes plain optional, so an omitted field stays omitted |

`pick` and `omit` take string keys, not `{ a: true }` masks. All four build a new object over the same field schemas, so retained fields keep their behaviour. Refinements and checks declared on the object itself are not carried over, because they may read fields the new object lacks; declare them again on the derived object.

```ts
const base = k.object({ name: k.string().trim().min(1), email: k.string(), note: k.string() })
const create = base.omit('note')
const patch = base.pick('name', 'note').partial()
const withId = create.extend({ id: k.id('people') })
```

## Defaults

A default makes the field optional on input and required on output:

- `k.input` marks the field optional; `k.infer` marks it required.
- The input-side native validator (`schema.validator`) has the field as `v.optional(...)`. That side is used for function args and table definitions.
- The output-side native validator (`schema.outputValidator`) has the field as required. That side is used for function returns.
- `parse` fills the default when the value is `undefined`. `.partial()` does not fill defaults.

## Transforms

`transform` and `pipe` produce a distinct schema kind:

- Allowed on input positions: function args, command and contract inputs, and `parse`.
- Rejected on table fields (`kTable`, `createTable`, `tenantTable`, `kVariantTable`), at the type level and when the table is defined.
- Rejected on function `returns` when the validators are exported; the kit does not run return transforms.

The type-preserving normalisers `trim`, `toLowerCase`, `toUpperCase` and `overwrite` are not transforms and are allowed everywhere, including table fields.

```ts
const args = { amount: k.string().regex(/^\d+$/).transform(Number) } // allowed in args
const fields = { title: k.string().trim() } // allowed in a table
```

There is no `catch`, `coerce` or `preprocess`. Parse the raw value with a transform on an input-position schema instead.

## Dates

The date schemas have no dependency and use UTC.

| Schema            | Conversion (input positions only)                                                  |
| ----------------- | ---------------------------------------------------------------------------------- |
| `k.isoDate()`     | `.toTimestamp()` → UTC midnight in milliseconds                                    |
| `k.isoDateTime()` | `.toTimestamp()` → milliseconds                                                    |
| `k.timestamp()`   | `.toIsoDateTime()` → `YYYY-MM-DDTHH:mm:ss.sssZ`; `.toIsoDate()` → UTC `YYYY-MM-DD` |

`k.timestamp()` accepts 1970-01-01T00:00:00.000Z through 9999-12-31T23:59:59.999Z (0 through 253402300799999); a negative value is `too_small` and a later one `too_big`. A conversion whose result falls outside that range, such as `k.isoDate().toTimestamp()` on `'1969-12-31'`, reports an `invalid_value` issue instead of throwing.

The conversions are transforms, so table fields reject them. Store the ISO string or the timestamp and convert in args:

```ts
const args = { day: k.isoDate().toTimestamp() } // handler receives a number
```

`k.isoDate()` and `k.isoDateTime()` keep the string methods (`min`, `regex`, `trim`, …); `k.timestamp()` keeps the number methods. Time zones, formatting and date arithmetic stay in app code.

## Parse and issues

```ts
const result = documentInput.safeParse(input)
if (!result.success) return result.issues // [{ path, code, message }]
const value = documentInput.parse(input) // throws KValidationError
```

- `safeParse` returns `{ success: true, data }` or `{ success: false, issues }`. There is no `.error`.
- `parse` throws `KValidationError`, a `ConvexError` whose `data` is `{ code: 'VALIDATION', issues }`.
- Each issue is `{ path: (string | number)[], code, message }`. Codes: `invalid_type`, `too_small`, `too_big`, `invalid_format`, `not_integer`, `invalid_value`, `unrecognized_key`, `invalid_union`, `custom`.
- All issues found in one walk are reported together.

The same error is raised for declared checks on function args, compact filter boundaries and `toPublicDto` projections. Structural failures on function args are raised by Convex itself before the kit runs, with Convex's own error. See [client-failures](client-failures.md) for reading errors on the client.

```ts
import { KValidationError, type KValidationData } from 'cvx-kit/k'
import { ConvexError } from 'convex/values'

function issuesOf(error: unknown) {
	if (error instanceof ConvexError && (error.data as KValidationData)?.code === 'VALIDATION')
		return (error.data as KValidationData).issues
	return undefined
}
```

## Types

| Type                                       | Meaning                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `k.infer<typeof S>` / `k.output<typeof S>` | the parsed value: defaults filled, transforms applied                                                        |
| `k.input<typeof S>`                        | what a caller sends: defaulted fields optional, transformed fields at their input type, ids as `Id<'table'>` |
| `NativeOf<typeof S>`                       | the input-side native validator type                                                                         |
| `OutputNativeOf<typeof S>`                 | the output-side native validator type                                                                        |

Input and output types differ only for a schema that declares a default or a transform. `k.input` of an object with no fields, `k.object({})`, is `{ readonly [key: string]: never }`, so an empty command input rejects extra properties at the type level. Ids are branded on input too: a caller passes an `Id<'users'>`, not a plain string.

## Native validators

- `schema.validator` is the input-side native validator. Use it wherever native Convex code wants a validator, for example `defineTable(schema.validator)` or `v.array(schema.validator)`.
- `schema.outputValidator` is the output-side native validator: defaulted fields are required and a transform is `v.any()`.

Both are built on first read and memoised. Native validators can sit next to `k` fields in function args (`{ id: k.id('t'), raw: v.string() }`); native fields are passed through untouched.

## Standard Schema

Every `k` schema implements Standard Schema v1 (`schema['~standard']`, vendor `cvx-kit`), and `validate` runs the same walker as `safeParse`. Contracts (`standardContract`) and form libraries that accept Standard Schema take `k` schemas directly.

## JSON Schema

`toJsonSchema(schema, { $schema? })` from `cvx-kit/json-schema` emits draft 2020-12 JSON Schema of the input side: optional and defaulted fields are not required (a JSON-compatible default is emitted), ids are strings, ISO dates carry `format: 'date'` or `'date-time'`, descriptions come from `.describe()`, transforms emit their input schema, and objects have `additionalProperties: false`. Repeated bounds keep the strongest one (`.min(2).min(5)` emits `minLength: 5`), and several `regex` checks emit the first as `pattern` and the rest as `allOf` patterns. Timestamps carry `maximum: 253402300799999`. Custom refinements are omitted. The entry is separate, so function bundles that do not import it do not load it.

```ts
import { toJsonSchema } from 'cvx-kit/json-schema'

const inputSchema = toJsonSchema(documentInput)
```

## Zod interop

`cvx-kit/zod` converts a `k` schema to Zod 4 for libraries that only accept Zod. Install `zod` (an optional peer) to use it. The result is a `zod/mini` schema: it has `parse`, `safeParse` and `check`, works with any library that accepts a Zod 4 schema, and converts back through convex-helpers' `zodToConvex`. It does not have the classic chain methods (`.optional()`, `.extend()`); extend it with the `zod/mini` functions (`z.optional(schema)`, `z.extend(schema, shape)`).

```ts
import { toZod } from 'cvx-kit/zod' // importing the entry also installs `.toZod()` on every schema

const zodSchema = toZod(documentInput)
const same = documentInput.toZod()
```

Carried: structure, strict objects (`strip()` objects strip), ids with their table typing (through convex-helpers' `zid`), `min`, `max`, `length`, `regex`, `int`, `trim`, case normalisers, defaults, ISO date formats, timestamps (with their range) and descriptions. A default converts to Zod's `prefault`, so it runs through the rest of the chain as in `k`, and a `partial()` field carries no default. Not carried: `refine`, `check`, `overwrite`, `transform` and `pipe`; a transformed schema converts to its input schema. Conversion is one way: there is no Zod → `k` conversion. Importing `cvx-kit/zod` puts Zod's core into that bundle (about 150 KB unminified, against over 700 KB for classic Zod), so keep it out of Convex function modules that do not need it. Calling `.toZod()` without importing the entry throws an error that names the entry.

## Performance model

Declaring a schema only records a chain: each chained call allocates one small record, and nothing else is built at import. Native validators and parse plans are built when Convex or a parse first asks for them, then memoised. A function whose schemas declare no checks, defaults, normalisers or transforms does no validation work of its own on a call; Convex validates the structure.

Declare function `args` and `returns` as getters. Convex re-evaluates a module's whole import graph on every call, and a getter means a call builds only the validators of the function it invokes; on the benchmark app (about 30 tables, 14 functions) module load drops from 8.43 ms to 6.30 ms. The property form (`args: input`) is still supported and validates identically.

```ts
export const getDocument = authQuery({
	get args() {
		return k.object({ id: k.id('documents') })
	},
	get returns() {
		return documentDto.nullable()
	},
	handler: (ctx, args) => ctx.db.get(args.id),
})
```

Measured results are in `docs/benchmarks/validators.md` in the repository.
