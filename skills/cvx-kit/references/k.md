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

| Factory                                  | Parses                                                                                                                                             | Native validator                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `k.string()`                             | string                                                                                                                                             | `v.string()`                                                        |
| `k.number()`                             | any number, including `NaN` and `±Infinity` (as `v.number()`)                                                                                      | `v.number()`                                                        |
| `k.int()`                                | a number for which `Number.isInteger` holds                                                                                                        | `v.number()`                                                        |
| `k.int64()`                              | bigint                                                                                                                                             | `v.int64()`                                                         |
| `k.boolean()`                            | boolean                                                                                                                                            | `v.boolean()`                                                       |
| `k.null()`                               | `null`                                                                                                                                             | `v.null()`                                                          |
| `k.bytes()`                              | `ArrayBuffer`                                                                                                                                      | `v.bytes()`                                                         |
| `k.any()`                                | any value except `undefined`                                                                                                                       | `v.any()`                                                           |
| `k.json()`                               | a JSON-compatible value, checked throughout (finite numbers, plain objects)                                                                        | union of string, number, boolean, null, array of any, record of any |
| `k.jsonObject()`                         | a plain object of JSON values with any keys Convex accepts in an object value (`_id` included); see [Open objects](#open-objects)                | `v.any()`                                                           |
| `k.literal(value)`                       | one string, number, bigint or boolean                                                                                                              | `v.literal(value)`                                                  |
| `k.enum(values)`                         | one of a non-empty tuple of strings; `.options` returns the tuple, `.enum` a value-to-value record, `.exclude([...])`/`.extract([...])` a new enum | union of literals (a one-value enum is a one-member union)          |
| `k.id('table')`                          | a string; typed `Id<'table'>` on input and output                                                                                                  | `v.id('table')`                                                     |
| `k.array(element)`                       | an array; `.element` returns the element schema                                                                                                    | `v.array(...)`                                                      |
| `k.object(fields)`                       | a plain object with exactly these keys                                                                                                             | `v.object(...)`                                                     |
| `k.looseObject(fields)`                  | `k.object(fields).loose()`: these fields, unknown keys kept; see [Open objects](#open-objects)                                                    | `v.object(...)` (closed)                                            |
| `k.record(key, value)`                   | a plain object; `key` is a string or id schema, or a finite set of string literals; see [Records](#records)                                        | `v.record(...)`, or `v.object(...)` for literal keys                |
| `k.partialRecord(key, value)`            | an object with one optional field per value of a literal key set; see [Records](#records)                                                          | `v.object(...)` with optional fields                                |
| `k.union([a, b, ...])`                   | the first member that parses (two or more members)                                                                                                 | `v.union(...)`                                                      |
| `k.discriminatedUnion(key, [a, b, ...])` | the option whose `key` field (a literal or enum) matches; values unique                                                                            | `v.union(...)` of the objects                                       |
| `k.isoDate()`                            | `YYYY-MM-DD` naming a real calendar day                                                                                                            | `v.string()`                                                        |
| `k.isoDateTime()`                        | ISO 8601 date-time with seconds and a `Z` or `±HH:MM` offset                                                                                       | `v.string()`                                                        |
| `k.timestamp()`                          | integer milliseconds from 1970-01-01 through the end of 9999 (UTC)                                                                                 | `v.number()`                                                        |

Argument-less factories return one shared, immutable root, so `k.string()` allocates nothing.

`k.number()` accepts `NaN` and infinities because native `v.number()` does. `min`, `max` and `length` reject `NaN`, and `.int()` and `k.int()` reject both `NaN` and infinities. Add `.finite()` when an unbounded number must be finite:

```ts
const amount = k.number().finite()
```

### Records

A string, id or ISO date key (or a union of those) builds a native `v.record`. Convex refuses a record whose keys are literals when the functions are pushed (`Records cannot have string literal keys`; convex-test accepts it), so a key that is a finite set of string literals (`k.enum([...])`, `k.literal('x')` or a union of string literals) builds a strict object with one required field per value, as v1's `z.record(z.enum([...]), value)` did. Its type is `Record<'a' | 'b', V>`, parse reports a missing key and an unknown key, and JSON Schema and `.toZod()` see an object. `k.partialRecord(k.enum([...]), value)` builds the same object with every field optional (`z.partialRecord`). Any other key kind (a number, a numeric literal, a union mixing literals with strings) is a type error and throws at declaration naming the kind, as does a literal key that is not a valid Convex field name.

```ts
const totals = k.object({
	byStatus: k.record(k.enum(['open', 'closed']), k.number()), // { open: number; closed: number }
	seen: k.partialRecord(k.enum(['open', 'closed']), k.boolean()), // { open?: boolean; closed?: boolean }
})
```

Object field names follow Convex's field-name rule: non-empty, at most 1024 characters, printable ASCII and not starting with `$` (a leading `_` is allowed, as for `_id`). A field that breaks it throws when the object's validator is first built, which happens when Convex analyses the functions, rather than at push.

After the key schema has run (including normalisers such as `trim`), each key of a native record must also satisfy Convex's record-key rule: non-empty, at most 1024 characters, printable ASCII, and not starting with `$` or `_` (the rule `v.record` documents in `convex/src/values/validator.ts`; `k` is exactly as strict). A key that breaks the rule fails with an `invalid_format` issue at that key's path. Parse writes every output key as an own property, so a key such as `__proto__` cannot reach a prototype.

### Discriminated unions

Each discriminator value must belong to one option. Two options that share a value (two equal literals, or an enum that overlaps another option's literal) make the schema throw when it is first used, for example on the first `parse` or the first call of a function that declares it. Declaring it does not throw.

### Immutability

Schemas are immutable, and so are the containers they hold:

- The arrays and objects passed to `k.enum`, `k.union`, `k.discriminatedUnion` and `k.record`, and the options object (and its `path`) passed to `refine`, are frozen at declaration.
- An object's field map is frozen the first time `.shape` is read, including the field map of a `pick`, `omit`, `extend` or `partial` result.

A shared array or field object therefore becomes read-only: a later `push` or property assignment throws in strict mode. Spreading it (`[...STATUSES, 'archived']`, `{ ...fields, extra }`) and `.extend(...)` still work. Do not mutate a field object after passing it to `k.object`.

## Chain methods

Every method returns a new immutable schema. Reusing a schema in several places is safe.

| Method                                          | On                          | Effect                                                                                                                                                                    |
| ----------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.optional()`                                   | all                         | may be `undefined`; natively `v.optional(...)`                                                                                                                            |
| `.nullable()`                                   | all                         | may be `null`; natively `v.union(T, v.null())`                                                                                                                            |
| `.default(value)`                               | all                         | fills `value` when the input is `undefined`; see [Defaults](#defaults)                                                                                                    |
| `.min(n, message?)` / `.max(n, message?)`       | string, number, array       | inclusive length or value bound                                                                                                                                           |
| `.length(n, message?)`                          | string, array               | exact length                                                                                                                                                              |
| `.regex(pattern, message?)`                     | string                      | the pattern must match                                                                                                                                                    |
| `.int(message?)`                                | number                      | `Number.isInteger` must hold                                                                                                                                              |
| `.positive()` / `.negative()`                   | number                      | `> 0` (`too_small`) / `< 0` (`too_big`)                                                                                                                                   |
| `.nonnegative()` / `.nonpositive()`             | number                      | `.min(0)` / `.max(0)`                                                                                                                                                     |
| `.finite()`                                     | number                      | rejects `NaN` and `±Infinity` (`invalid_type`)                                                                                                                            |
| `.safe()`                                       | number                      | a safe integer: `not_integer`, or `too_small`/`too_big` outside the range                                                                                                 |
| `.trim()` / `.toLowerCase()` / `.toUpperCase()` | string                      | type-preserving normalisers                                                                                                                                               |
| `.overwrite(fn)`                                | all                         | a type-preserving normaliser: `fn(value)` replaces the value                                                                                                              |
| `.refine(fn, message?)`                         | all                         | `fn(value)` must return `true`; `message` is a string or `{ message, path }`; a type guard `(v) => v is U` narrows the output (and the input, without a transform) to `U` |
| `.check((value, ctx) => …)`                     | all                         | adds any number of issues with `ctx.addIssue({ message, path?, code? })`                                                                                                  |
| `.transform(fn)`                                | all                         | a type-changing step; see [Transforms](#transforms)                                                                                                                       |
| `.pipe(schema)`                                 | all                         | parse this schema's output with `schema`; a transform kind                                                                                                                |
| `.describe(text)`                               | all                         | a description for JSON Schema and tooling; `.description` reads it                                                                                                        |
| `.unwrap()`                                     | optional, nullable, default | the schema below the wrapper; `.removeDefault()` is the same on a default                                                                                                 |
| `.strip()`                                      | object                      | parse removes unknown keys instead of reporting them                                                                                                                      |

Checks and normalisers run in declaration order after the structure is valid: normalisers first, then checks. Messages are optional; each check has a default message.

A type-guard `refine` narrows the schema and everything chained on it, including an object field that uses it. For an optional or nullable field, write the guard on the wrapped schema so the field's native type narrows too; `.refine(guard).optional()` narrows the output only:

```ts
const at = k.string().refine(isTimeOfDay) // TimeOfDay
const maybeAt = k
	.string()
	.optional()
	.refine((value): value is TimeOfDay | undefined => value === undefined || isTimeOfDay(value))
```

Refinements, checks, normalisers and transforms are synchronous. A `refine` callback that returns a promise fails with an `Invalid input` issue, a `check` that returns one adds `A check must be synchronous`, and a `transform` or `overwrite` that returns one fails with a `custom` issue saying async callbacks are not supported. Do asynchronous work in the handler.

```ts
const range = k.object({ from: k.int(), to: k.int() }).check((value, ctx) => {
	if (value.from > value.to) ctx.addIssue({ path: ['to'], message: 'to must be >= from' })
	if (value.to - value.from > 1000) ctx.addIssue({ message: 'range too large' })
})
```

## Objects

`k.object(fields)` is strict by default: parse reports each unknown key as an `unrecognized_key` issue, and the native validator is a closed `v.object`. Use `.strip()` when parse should drop unknown keys, `.loose()` when it should keep them (both keep the closed native validator), or a `k.record(...)` field for open-ended keys. There is no `catchall`.

| Operation                    | Result                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `.shape`                     | the field map; reusing a field keeps every check, default and normaliser declared on it                                   |
| `.pick('a', 'b')`            | a new object with those fields                                                                                            |
| `.omit('a', 'b')`            | a new object without those fields                                                                                         |
| `.extend({ c: k.string() })` | a new object with added or replaced fields                                                                                |
| `.partial()`                 | every field optional; a defaulted field becomes plain optional, so an omitted field stays omitted                         |
| `.required('a', …)`          | the named fields (every field when none are named) lose their top `optional()`, the inverse of `partial()`; defaults stay |
| `.keyof()`                   | a `k.enum` of the field names                                                                                             |

### Open objects

`.loose()` (or `k.looseObject(fields)`) is Zod's `looseObject`/`.passthrough()`: parse validates the declared fields and keeps every other own enumerable key in the output unchanged. When no field changes, the output is the input object itself. It is hardened like `.strip()`: a class instance is read from its own enumerable properties into a fresh plain object, inherited keys are never read, and keys such as `__proto__` are written as own data properties. Its output type names the declared fields only, so `pick`/`omit` typing is unchanged; derived objects (`pick`, `extend`, …) are strict again.

Convex has no open object validator, so the native validator of a loose object is the same closed `v.object` as v1's conversion of `z.looseObject`/`.passthrough()` (convex-helpers `zodToConvex` converted every `ZodObject` to `v.object(shape)`). Convex therefore still rejects unknown keys in function args, returns and documents: `.loose()` is for `parse`/`safeParse` of provider payloads (webhooks, SDK responses). To accept unknown keys at a function boundary, take the payload as `k.any()` or `k.jsonObject()` and parse it with the loose schema in the handler.

`k.jsonObject()` is any plain object of JSON values, for values that are not a Convex record, such as workflow step outputs carrying `_id`/`_creationTime`. It rejects arrays, `null`, class instances and non-JSON values (`undefined`, `NaN`, bigints, `ArrayBuffer`s). Its native validator is `v.any()`, because no typed validator accepts such an object: `v.record` refuses keys starting with `_` or `$`. Convex validates nothing about it, so the kit checks the whole value at a function boundary.

Keys follow Convex's rule for object values, at any depth: at most 1024 characters, printable ASCII, and no leading `$`. That is `validateObjectField` in `convex/src/values/value.ts`, which Convex's client runs on every object value it serialises (`convexToJson`, `jsonToConvex`), so an argument or return value with a `$` key cannot cross the wire at all. A key that breaks it fails with `Invalid object key: Convex refuses '$'-prefixed, …` at that key. The kit also refuses an empty key, which Convex's value rule allows. A leading `_` passes that rule, so `_`-prefixed keys work in arguments and return values. In stored documents, Convex reserves top-level `_` fields for system fields; whether the backend accepts `_`-prefixed keys nested in a `v.any()` field is enforced server-side and cannot be checked from the `convex` package, so test a write on your deployment before storing such keys.

```ts
const stripeEvent = k.looseObject({ id: k.string(), type: k.string() })
stripeEvent.parse({ id: 'evt_1', type: 'charge', livemode: true }) // keeps livemode
const stepOutput = k.jsonObject()
stepOutput.parse({ _id: 'abc', _creationTime: 1 }) // ok
stepOutput.parse({ $ref: 1 }) // fails: Convex's '$' rule
```

### Class instances

Parse accepts plain objects only (prototype `Object.prototype` or `null`), so a class instance, a `Date` or a `Map` fails with `Invalid input: expected a plain object, received an instance of TaggedError`. Function arguments and stored documents are always plain, so this only matters when you `parse` an in-memory value such as an Effect tagged error or an SDK error. A `.strip()` object accepts an instance: it reads the instance's own enumerable properties into a fresh plain object and drops the rest, so nothing is read through the prototype chain (a class getter or an inherited field counts as missing) and the output never keeps the instance's prototype.

```ts
class NotFound extends Error {
	readonly _tag = 'NotFound'
}
k.object({ _tag: k.string() }).strip().parse(new NotFound()) // { _tag: 'NotFound' }
k.object({ _tag: k.string() }).parse(new NotFound()) // throws: expected a plain object
```

`pick` and `omit` take string keys, not `{ a: true }` masks. `pick`, `omit`, `extend`, `partial` and `required` build a new object over the same field schemas, so retained fields keep their behaviour. A `refine`, `check` or `overwrite` declared on the object itself may read fields the new object lacks or makes optional, so on an object that has one these methods throw at declaration, naming the method and how many checks would be dropped. Say what you want with a last argument:

- `{ dropChecks: true }` on any of the five drops them: `range.pick('from', { dropChecks: true })`, `range.partial({ dropChecks: true })`, `range.required('to', { dropChecks: true })`.
- `{ keepChecks: true }`, on `extend` only, re-attaches them to the extended object in their declared order; they run against the extended value. Use it when the extension does not redefine a field the check reads.

`strip()`, `describe()`, `optional()` and `nullable()` derive no new shape and keep the checks. Checks on a field's own schema always travel with the field.

```ts
const range = k.object({ from: k.int(), to: k.int() }).refine((r) => r.from <= r.to)
range.extend({}) // throws: extend() would drop 1 object-level check(s)
range.extend({ note: k.string() }, { keepChecks: true }) // still checks from <= to
range.pick('from', { dropChecks: true }) // no check
```

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

There is no `coerce` or `preprocess`. Parse the raw value with a transform on an input-position schema instead.

## Fallbacks

`.catch(fallback)` is Zod 4's `catch`: when the schema reports issues, parse succeeds with the fallback instead. The fallback is a value, or a function receiving `{ issues, input }` (the issues the schema reported and the raw input). The fallback itself is not validated.

```ts
const role = k.enum(['admin', 'member']).catch('member')
role.parse('owner') // 'member'
const level = k.int().min(0).catch(({ input }) => (typeof input === 'string' ? input.length : 0))
```

- Types: output and input are the wrapped schema's, as in Zod 4. There is no `.unwrap()`; keep a reference to the wrapped schema.
- Native validators: the input side is `v.any()` (`v.optional(v.any())` when the wrapped schema is optional), because the fallback accepts any input; the output side is the wrapped schema's. Convex therefore validates nothing about the value, and at a function boundary the kit runs the wrapped schema's full structural check on it, not only declared checks.
- Allowed in args and `parse`. Rejected on table fields and in `returns`, like `transform`: the stored or returned shape would become `v.any()`. v1 converted `ZodCatch` to the wrapped validator (convex-helpers `zodToConvex`), so Convex rejected a bad argument before the fallback could apply; in 2.0 the fallback applies.
- `toJsonSchema` emits `{}` on the input side and the wrapped schema with `{ io: 'output' }`. `toZod` throws on a schema holding `catch` (`.catch() is not carried`): `z.catch` would add about 10 KB of Zod core to every bundle of the interop entry. Convert the wrapped schema and add `z.catch` yourself.

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
- When nothing is normalised (no default filled, no normaliser or transform changed a value, no key stripped), `parse` returns the input object itself, not a copy: the result is `===` the input, and keys keep the input's order, not the schema's. Code that compares `JSON.stringify(schema.parse(a))` across inputs, or relies on the output's key order, must sort or rebuild explicitly; code that mutates the result mutates the input. When a value is normalised, the output is a new plain object in schema key order.

```ts
const user = k.object({ id: k.string(), name: k.string() })
const input = { name: 'Ada', id: 'u1' }
user.parse(input) === input // true; JSON.stringify gives {"name":"Ada","id":"u1"}
const stable = (value: Record<string, unknown>) =>
	JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
const copy = { ...user.parse(input) } // a copy when it will be mutated
```

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

| Type                                       | Meaning                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `k.infer<typeof S>` / `k.output<typeof S>` | the parsed value: defaults filled, transforms applied                                                                         |
| `k.input<typeof S>`                        | what a caller sends: defaulted fields optional, transformed fields at their input type, ids as `Id<'table'>`                  |
| `NativeOf<typeof S>`                       | the input-side native validator type                                                                                          |
| `OutputNativeOf<typeof S>`                 | the output-side native validator type                                                                                         |
| `AnyKSchema`                               | any `k` schema as a parameter type, with `optional()`, `nullable()`, `describe()`, `parse`, `safeParse` and `outputValidator` |
| `KType`                                    | the structural shape every schema satisfies (`validator`, `_output`); a constraint, not a parameter type                      |
| `KRecordKey`                               | what `k.record` accepts as its key schema                                                                                     |

Which to use for a helper that takes any schema:

- `schema: AnyKSchema` when the helper calls schema methods (`schema.optional()`, `schema.parse(x)`, `schema.outputValidator`). Every `k` schema is assignable to it; the methods return `AnyKSchema` and `any`.
- `S extends KType` when the helper must keep the exact schema type in its result, for example to pass it on to `k.object` or a builder's `args`. `KType` has no methods; name the result type yourself.

```ts
import type { AnyKSchema, KOptional, KType } from 'cvx-kit/k'

function describeAll(schemas: readonly AnyKSchema[]) {
	return schemas.map((schema) => schema.outputValidator)
}

function optionalField<S extends KType>(schema: S & AnyKSchema): KOptional<S> {
	return schema.optional() as KOptional<S>
}
```

Input and output types differ only for a schema that declares a default or a transform. A `k.any()` field stays required beside a defaulted field (only `.optional()` makes it optional). `k.input` of an object with no fields, `k.object({})`, is `{ readonly [key: string]: never }`, so an empty command input rejects extra properties at the type level. Ids are branded on input too: a caller passes an `Id<'users'>`, not a plain string.

## Native validators

- `schema.validator` is the input-side native validator. Use it wherever native Convex code wants a validator, for example `defineTable(schema.validator)` or `v.array(schema.validator)`.
- `schema.outputValidator` is the output-side native validator: defaulted fields are required and a transform is `v.any()`.

Both are built on first read and memoised. Native validators can sit next to `k` fields in function args (`{ id: k.id('t'), raw: v.string() }`); native fields are passed through untouched.

## Standard Schema

Every `k` schema implements Standard Schema v1 (`schema['~standard']`, vendor `cvx-kit`), and `validate` runs the same walker as `safeParse`. Contracts (`standardContract`) and form libraries that accept Standard Schema take `k` schemas directly.

## JSON Schema

`toJsonSchema(schema, { $schema?, io? })` from `cvx-kit/json-schema` emits draft 2020-12 JSON Schema of the input side: optional and defaulted fields are not required (a JSON-compatible default is emitted), ids are strings, ISO dates carry `format: 'date'` or `'date-time'`, descriptions come from `.describe()`, transforms emit their input schema, and objects have `additionalProperties: false`. Repeated bounds keep the strongest one (`.min(2).min(5)` emits `minLength: 5`), and several `regex` checks emit the first as `pattern` and the rest as `allOf` patterns. Timestamps carry `maximum: 253402300799999`. `.positive()`/`.negative()` emit `exclusiveMinimum`/`exclusiveMaximum`, and `.safe()` emits an integer with the safe range. Custom refinements are omitted.

`{ io: 'output' }` describes what parse returns instead, as Zod's `io` option: a defaulted field is required, a pipe emits its target's output, and a transform emits `{}` (any value), as `outputValidator` emits `v.any()`. The entry is separate, so function bundles that do not import it do not load it.

```ts
import { toJsonSchema } from 'cvx-kit/json-schema'

const inputSchema = toJsonSchema(documentInput)
const outputSchema = toJsonSchema(documentInput, { io: 'output' })
```

## Zod interop

`cvx-kit/zod` converts a `k` schema to Zod 4 for libraries that only accept Zod. Install `zod` (an optional peer) to use it. The result is a `zod/mini` schema: it has `parse`, `safeParse` and `check`, works with any library that accepts a Zod 4 schema, and converts back through convex-helpers' `zodToConvex`. It does not have the classic chain methods (`.optional()`, `.extend()`); extend it with the `zod/mini` functions (`z.optional(schema)`, `z.extend(schema, shape)`).

```ts
import { toZod } from 'cvx-kit/zod' // importing the entry also installs `.toZod()` on every schema

const zodSchema = toZod(documentInput)
const same = documentInput.toZod()
```

Carried: structure, strict objects (`strip()` objects strip, `loose()` objects convert to `z.looseObject`, `k.jsonObject()` to `z.record(z.string(), z.json())`), ids with their table typing (an id converts to `z.string()`, typed as the table's `Id`, with its table name recorded in the exported `kZodIds` registry: `kZodIds.get(schema)?.tableName`; convex-helpers' `zodToConvex` sees it as a plain string), `min`, `max`, `length`, `regex`, `int`, `trim`, case normalisers, defaults, ISO date formats, timestamps (with their range) and descriptions. A default converts to Zod's `prefault`, so it runs through the rest of the chain as in `k`, and a `partial()` field carries no default. Not carried (throws): `catch`. Not carried: `refine`, `check`, `overwrite`, `transform` and `pipe`; a transformed schema converts to its input schema. Conversion is one way: there is no Zod → `k` conversion. Importing `cvx-kit/zod` puts Zod's core into that bundle (about 73 KB unminified, against over 700 KB for classic Zod), so keep it out of Convex function modules that do not need it. Calling `.toZod()` without importing the entry throws an error that names the entry.

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
