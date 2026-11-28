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

| Factory                                  | Parses                                                                                                                                 | Native validator                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `k.string()`                             | string                                                                                                                                 | `v.string()`                                                        |
| `k.email(message?)`                      | a string matching Zod 4's email pattern; `k.string().email()`                                                                          | `v.string()`                                                        |
| `k.url(options?)`                        | a string the WHATWG URL parser accepts; `{ protocol, hostname }` patterns narrow it; `k.string().url()`                                | `v.string()`                                                        |
| `k.number()`                             | any number, including `NaN` and `±Infinity` (as `v.number()`)                                                                          | `v.number()`                                                        |
| `k.int()`                                | a number for which `Number.isSafeInteger` holds                                                                                        | `v.number()`                                                        |
| `k.int64()`                              | bigint                                                                                                                                 | `v.int64()`                                                         |
| `k.boolean()`                            | boolean                                                                                                                                | `v.boolean()`                                                       |
| `k.null()`                               | `null`                                                                                                                                 | `v.null()`                                                          |
| `k.void()`                               | `undefined` or `null`; for `returns` only, see [Void returns](#void-returns)                                                           | `v.null()`                                                          |
| `k.bytes()`                              | `ArrayBuffer`                                                                                                                          | `v.bytes()`                                                         |
| `k.any()`                                | any value except `undefined`                                                                                                           | `v.any()`                                                           |
| `k.custom<T>(guard?, message?)`          | any value except `undefined`, typed `T`; `guard` (when given) must return a truthy value, issue `custom`                               | `v.any()`                                                           |
| `k.json()`                               | a JSON-compatible value, checked throughout (finite numbers, plain objects)                                                            | union of string, number, boolean, null, array of any, record of any |
| `k.jsonObject()`                         | a plain object of JSON values with any keys Convex accepts in an object value (`_id` included); see [Open objects](#open-objects)      | `v.any()`                                                           |
| `k.literal(value)`                       | one string, number, bigint or boolean                                                                                                  | `v.literal(value)`                                                  |
| `k.enum(values)`                         | one of a non-empty array of strings, or of an object's string values; `.options`, `.enum`, `.exclude`, `.extract`: see [Enums](#enums) | union of literals (a one-value enum is a one-member union)          |
| `k.id('table')`                          | a string; typed `Id<'table'>` on input and output                                                                                      | `v.id('table')`                                                     |
| `k.array(element)`                       | an array; `.element` returns the element schema                                                                                        | `v.array(...)`                                                      |
| `k.object(fields)`                       | these declared fields; application parse strips unknown keys                                                                           | `v.object(...)`                                                     |
| `k.strictObject(fields)`                 | `k.object(fields).strict()`: parse rejects unknown keys                                                                                | `v.object(...)` (closed)                                            |
| `k.looseObject(fields)`                  | `k.object(fields).loose()`: these fields, unknown keys kept; see [Open objects](#open-objects)                                         | `v.object(...)` (closed)                                            |
| `k.record(key, value)`                   | a plain object; `key` is a string or id schema, or a finite set of string literals; see [Records](#records)                            | `v.record(...)`, or `v.object(...)` for literal keys                |
| `k.partialRecord(key, value)`            | an object with one optional field per value of a literal key set; see [Records](#records)                                              | `v.object(...)` with optional fields                                |
| `k.union([a, b, ...])`                   | the first member that parses (two or more members)                                                                                     | `v.union(...)`                                                      |
| `k.discriminatedUnion(key, [a, b, ...])` | the option whose `key` field (a literal or enum) matches; values unique                                                                | `v.union(...)` of the objects                                       |
| `k.isoDate()`                            | `YYYY-MM-DD` naming a real calendar day                                                                                                | `v.string()`                                                        |
| `k.isoDateTime()`                        | ISO 8601 date-time with seconds and a `Z` or `±HH:MM` offset                                                                           | `v.string()`                                                        |
| `k.timestamp()`                          | integer milliseconds from 1970-01-01 through the end of 9999 (UTC)                                                                     | `v.number()`                                                        |

Argument-less factories return one shared, immutable root, so `k.string()` allocates nothing.

`k.number()` accepts `NaN` and infinities because native `v.number()` does. `min`, `max` and `length` reject `NaN`, and `.int()` and `k.int()` reject both `NaN` and infinities. Integers require `Number.isSafeInteger`: non-integers report `not_integer`, and integers outside the safe range report `too_small` or `too_big`. `.safe()` is redundant on an integer. Add `.finite()` when an unbounded number must be finite:

```ts
const amount = k.number().finite()
```

### Records

A string, id or ISO date key (or a union of those) builds a native `v.record`. Convex refuses a record whose keys are literals when the functions are pushed (`Records cannot have string literal keys`; convex-test accepts it), so a key that is a finite set of string literals (`k.enum([...])`, `k.literal('x')` or a union of string literals) builds an object with a closed native validator and one required field per value, as v1's `z.record(z.enum([...]), value)` did. Its type is `Record<'a' | 'b', V>`, parse reports missing required keys, and JSON Schema and `.toZod()` see an object. The object is `.strict()`: parse and kit boundaries both reject keys outside the set. `k.partialRecord(k.enum([...]), value)` builds the same object with every field optional (`z.partialRecord`). Any other key kind (a number, a numeric literal, a union mixing literals with strings) is a type error and throws at declaration naming the kind, as does a literal key that is not a valid Convex field name.

```ts
const totals = k.object({
	byStatus: k.record(k.enum(['open', 'closed']), k.number()), // { open: number; closed: number }
	seen: k.partialRecord(k.enum(['open', 'closed']), k.boolean()), // { open?: boolean; closed?: boolean }
})
```

Object field names follow Convex's field-name rule: non-empty, at most 1024 characters, printable ASCII and not starting with `$` (a leading `_` is allowed, as for `_id`). A field that breaks it throws when the object's validator is first built, which happens when Convex analyses the functions, rather than at push.

After the key schema has run (including normalisers such as `trim`), each key of a native record must also satisfy Convex's record-key rule: non-empty, at most 1024 characters, printable ASCII, and not starting with `$` or `_` (the rule `v.record` documents in `convex/src/values/validator.ts`; `k` is exactly as strict). A key that breaks the rule fails with an `invalid_format` issue at that key's path. Parse writes every output key as an own property, so a key such as `__proto__` cannot reach a prototype.

### Discriminated unions

Every option must be a `k.object` whose discriminator field is a literal, an enum, or a union of literals and enums (natively the same union as an enum; parse dispatches on each value). Each discriminator value must belong to one option. Declaring the union throws if an option breaks either rule, naming the key, the option index and what was found (for example `option 1 has 'string'`, or `'kind' value "a" (option 1 repeats it)`). The check reads only the options' field maps and builds no validator.

### Enums

`k.enum` takes a non-empty array of strings, or an object whose values are all strings (an `as const` object or a TypeScript string enum). Both forms build the same schema, and parse accepts the values, not the keys:

```ts
const Status = { Open: 'open', Done: 'done' } as const
k.enum(Status) // the same schema as k.enum(['open', 'done'])
k.enum(Status).parse('open') // 'open'; 'Open' fails
```

`.options` returns the value tuple, `.enum` a value-to-value record, and `.exclude([...])`/`.extract([...])` a new enum. A string, an empty array or object, a non-string value, `null`, or an object that is not a plain object (a `Date`, a class instance) throws a `TypeError` at definition. A numeric TypeScript enum is refused the same way, because its object also maps each number back to its name; use `k.union([k.literal(0), k.literal(1)])` for numeric values.

### Void returns

`k.void()` declares a function that returns nothing. Use it for `returns` only. Its native validator is `v.null()`, because Convex sends a missing result as `null`, so clients receive `null`. The handler may return nothing, `undefined` or `null`. Parse accepts `undefined` and `null`.

```ts
export const touch = authMutation({
	args: k.object({ id: k.id('documents') }),
	returns: k.void(),
	handler: async (ctx, { id }) => {
		await ctx.db.patch(id, { touchedAt: Date.now() })
	},
})
```

For a value that may be absent in args or an object field, use `.optional()`. `k.custom()` and `k.any()` still refuse `undefined`.

### Immutability

Schemas are immutable, and so are the containers they hold:

- The arrays and objects passed to `k.enum`, `k.union`, `k.discriminatedUnion` and `k.record`, and the options object (and its `path`) passed to `refine`, are frozen at declaration.
- An object's field map is frozen the first time `.shape` is read, including the field map of a `pick`, `omit`, `extend` or `partial` result.

A shared array or field object therefore becomes read-only: a later `push` or property assignment throws in strict mode. Spreading it (`[...STATUSES, 'archived']`, `{ ...fields, extra }`) and `.extend(...)` still work. Do not mutate a field object after passing it to `k.object`.

## Chain methods

Every method returns a new immutable schema. Reusing a schema in several places is safe.

| Method                                          | On                           | Effect                                                                                                                                                                                                                         |
| ----------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.optional()`                                   | all                          | may be `undefined`; natively `v.optional(...)`                                                                                                                                                                                 |
| `.nullable()`                                   | all                          | may be `null`; natively `v.union(T, v.null())`                                                                                                                                                                                 |
| `.default(value)`                               | all                          | fills `value` when the input is `undefined`; see [Defaults](#defaults)                                                                                                                                                         |
| `.min(n, message?)` / `.max(n, message?)`       | string, number, int64, array | inclusive length or value bound                                                                                                                                                                                                |
| `.length(n, message?)`                          | string, array                | exact length                                                                                                                                                                                                                   |
| `.regex(pattern, message?)`                     | string                       | the pattern must match                                                                                                                                                                                                         |
| `.email(message?)` / `.url(options?)`           | string                       | `invalid_format`; JSON Schema `format: 'email'` / `'uri'`                                                                                                                                                                      |
| `.int(message?)`                                | number                       | `Number.isSafeInteger` must hold; `not_integer` for non-integers, `too_small`/`too_big` outside the safe range                                                                                                                 |
| `.positive()` / `.negative()`                   | number, int64                | `> 0` (`too_small`) / `< 0` (`too_big`)                                                                                                                                                                                        |
| `.nonnegative()` / `.nonpositive()`             | number, int64                | `.min(0)` / `.max(0)`                                                                                                                                                                                                          |
| `.finite()`                                     | number                       | rejects `NaN` and `±Infinity` (`invalid_type`)                                                                                                                                                                                 |
| `.safe()`                                       | number                       | a safe integer; redundant on `k.int()` and after `.int()`                                                                                                                                                                      |
| `.trim()` / `.toLowerCase()` / `.toUpperCase()` | string                       | type-preserving normalisers                                                                                                                                                                                                    |
| `.overwrite(fn)`                                | all                          | a type-preserving normaliser: `fn(value)` replaces the value                                                                                                                                                                   |
| `.refine(fn, message?)`                         | all                          | `fn(value)` must return `true`; `message` is a string or `{ message, path }` (`error` is accepted as a string alias of `message`); a type guard `(v) => v is U` narrows the output (and the input, without a transform) to `U` |
| `.check((value, ctx) => …)`                     | all                          | adds any number of issues with `ctx.addIssue({ message, path?, code? })`                                                                                                                                                       |
| `.transform(fn)`                                | all                          | a type-changing step; `fn(value, context)` may call `context.addIssue(...)`; see [Transforms](#transforms)                                                                                                                     |
| `.pipe(schema)`                                 | all                          | parse this schema's output with `schema`; a transform kind                                                                                                                                                                     |
| `.describe(text)`                               | all                          | a description for JSON Schema and tooling; `.description` reads it                                                                                                                                                             |
| `.unwrap()`                                     | optional, nullable, default  | the schema below the wrapper; `.removeDefault()` is the same on a default                                                                                                                                                      |
| `.strip()`                                      | object                       | explicit stripping, including in the kit's full parse; input JSON Schema omits `additionalProperties: false`                                                                                                                   |
| `.strict()`                                     | object                       | application parse reports unknown keys as `unrecognized_key`; nested objects keep their own policy                                                                                                                             |

Checks and normalisers run in declaration order after the structure is valid: normalisers first, then checks. Messages are optional; each check has a default message.

A type-guard `refine` narrows the schema and everything built from it: the output, the input (without a transform) and the native validator's type, so an object field, array element, record value, union member, `pick`/`omit`/`extend`/`partial`/`required`, a table document and a function's `args` all see the narrowed type. `.optional()`, `.nullable()` and `.default()` after the guard keep it. The narrowing is type-only; the runtime validator stays `v.string()`:

```ts
const role = k.string().refine(isRole) // Role
const member = k.object({ roles: k.array(role), lead: role.optional() }) // { roles: Role[]; lead?: Role }
```

`k.custom<T>()` is Zod's `z.custom<T>()`: natively `v.any()`, so only the guard validates the value, at parse and at function boundaries. As in Zod, the value passes when the guard returns any truthy value. A guard that returns a promise never passes, because checks are synchronous. Use it for values a schema cannot describe (a branded string, an SDK payload). Its JSON Schema is `{}`; `toZod` carries the guard. It refuses `undefined`, like `k.any()`; for a function that returns nothing, use [`k.void()`](#void-returns).

On `k.int64()` the bounds take bigints (`k.int64().min(0n).max(MAX)`, `.positive()`), compare exactly at any magnitude and report `too_small`/`too_big`. A bound given as a safe-integer number (`.min(0)` from untyped code) is converted to a bigint. Any other bound (`0.5`, `NaN`, `'0'`, a number beyond the safe range) throws a `TypeError` at definition. JSON Schema states an int64 bound only when a JSON number holds it exactly.

Every check that takes a message (`min`, `max`, `length`, `regex`, `int`, `positive`, `negative`, `nonnegative`, `nonpositive`, `finite`, `safe`) also takes `{ message }`, and every options object also accepts Zod 4's `error: '…'` as a string alias of `message`; `message` wins when both are given. A function-valued `error` (Zod's error map) is a type error and throws at declaration, and an unknown option key is a type error.

Refinements, checks, normalisers and transforms are synchronous. A `refine` callback that returns a promise fails with an `Invalid input` issue, a `check` that returns one adds `A check must be synchronous`, and a `transform` or `overwrite` that returns one fails with a `custom` issue saying async callbacks are not supported. Do asynchronous work in the handler.

```ts
const range = k.object({ from: k.int(), to: k.int() }).check((value, ctx) => {
	if (value.from > value.to) ctx.addIssue({ path: ['to'], message: 'to must be >= from' })
	if (value.to - value.from > 1000) ctx.addIssue({ message: 'range too large' })
})
```

## Objects

`k.object(fields)` strips unknown keys when application code calls `parse`, `safeParse` or Standard Schema `validate`. Use `.strict()` or `k.strictObject(fields)` to report unknown keys as `unrecognized_key`, or `.loose()` to keep them. The policy is per object; a strict parent does not make its children strict. The last policy declared on a chain wins (`.strip().strict()` is strict). There is no `catchall`.

In a `k.union`, application parse first looks for a member that accepts every key of the value and only then for one that would strip some, so `k.union([k.object({ a }), k.object({ a, b })])` keeps `b` when it is present. Zod returns the first member that matches and drops `b`.

Kit boundaries still reject unknown keys: function `args` and `returns`, table fields and writes, `kContract`, Effect command inputs, CRUD masks, filters and cursors. The native validator is always a closed `v.object`. Explicit `.strip()` additionally makes the kit's full parse strip (for example inside `.catch` or under `skipConvexValidation`) and omits `additionalProperties: false` from input-side JSON Schema. Plain `k.object` still emits `additionalProperties: false` to describe the boundary.

| Operation                    | Result                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `.shape`                     | the field map; reusing a field keeps every check, default and normaliser declared on it                                   |
| `.pick('a', 'b')`            | a new object with those fields                                                                                            |
| `.omit('a', 'b')`            | a new object without those fields                                                                                         |
| `.extend({ c: k.string() })` | a new object with added or replaced fields                                                                                |
| `.partial()`                 | every field optional; a defaulted field becomes plain optional, so an omitted field stays omitted                         |
| `.partial('a', …)`           | only the named fields optional; the others keep their behaviour                                                           |
| `.required('a', …)`          | the named fields (every field when none are named) lose their top `optional()`, the inverse of `partial()`; defaults stay |
| `.keyof()`                   | a `k.enum` of the field names                                                                                             |

The derived objects keep the receiver's policy, including `.strict()`, `.strip()` and `.loose()`, as in Zod 4.

### Open objects

`.loose()` (or `k.looseObject(fields)`) is Zod's `looseObject`/`.passthrough()`: parse validates the declared fields and keeps every other own enumerable key in the output unchanged. When no field changes, the output is the input object itself. It is hardened like `.strip()`: a class instance is read from its own enumerable properties into a fresh plain object, inherited keys are never read, and keys such as `__proto__` are written as own data properties. Its output type names the declared fields only, so `pick`/`omit` typing is unchanged. Derived objects (`pick`, `omit`, `extend`, `partial`, `required`) keep the receiver's unknown-key policy, as Zod 4's do: a loose object's `pick` is loose, a stripping object's is stripping, a strict object's is strict.

Convex has no open object validator, so the native validator of a loose object is the same closed `v.object` as v1's conversion of `z.looseObject`/`.passthrough()` (convex-helpers `zodToConvex` converted every `ZodObject` to `v.object(shape)`). Convex therefore still rejects unknown keys in function args, returns and documents: `.loose()` is for `parse`/`safeParse` of provider payloads (webhooks, SDK responses). To accept unknown keys at a function boundary, take the payload as `k.any()` or `k.jsonObject()` and parse it with the loose schema in the handler.

`k.jsonObject()` is any plain object of JSON values, for values that are not a Convex record, such as workflow step outputs carrying `_id`/`_creationTime`. It rejects arrays, `null`, class instances and non-JSON values (`undefined`, `NaN`, bigints, `ArrayBuffer`s). Its native validator is `v.any()`, because no typed validator accepts such an object: `v.record` refuses keys starting with `_` or `$`. Convex validates nothing about it, so the kit checks the whole value at a function boundary. Its JSON Schema states the key rule for top-level keys (`propertyNames` with a pattern); nested keys are checked by parse only, because the recursive `$ref` form that could state them suits fewer tool-calling consumers.

Keys follow Convex's rule for object values, at any depth: at most 1024 characters, printable ASCII, and no leading `$`. That is `validateObjectField` in `convex/src/values/value.ts`, which Convex's client runs on every object value it serialises (`convexToJson`, `jsonToConvex`), so an argument or return value with a `$` key cannot cross the wire at all. A key that breaks it fails with `Invalid object key: Convex refuses '$'-prefixed, …` at that key. The kit also refuses an empty key, which Convex's value rule allows. A leading `_` passes that rule, so `_`-prefixed keys work in arguments and return values. In stored documents, Convex reserves top-level `_` fields for system fields; whether the backend accepts `_`-prefixed keys nested in a `v.any()` field is enforced server-side and cannot be checked from the `convex` package, so test a write on your deployment before storing such keys.

```ts
const stripeEvent = k.looseObject({ id: k.string(), type: k.string() })
stripeEvent.parse({ id: 'evt_1', type: 'charge', livemode: true }) // keeps livemode
const stepOutput = k.jsonObject()
stepOutput.parse({ _id: 'abc', _creationTime: 1 }) // ok
stepOutput.parse({ $ref: 1 }) // fails: Convex's '$' rule
```

### Class instances

Application parse of `k.object` accepts class instances. It reads only own enumerable properties into a fresh plain object and strips unknown keys; inherited fields and prototype getters count as missing. The output never retains the instance's prototype. `.strip()` and `.loose()` also read instances through their own enumerable properties. `k.jsonObject()` still requires a plain object.

```ts
class NotFound extends Error {
	readonly _tag = 'NotFound'
}
k.object({ _tag: k.string() }).parse(new NotFound()) // { _tag: 'NotFound' }
```

`pick`, `omit`, `partial` and `required` take string keys: `pick('a', 'b')`. A Zod-style mask object (`pick({ a: true })`) throws a `TypeError` at definition that names the key-list form. One mask cannot be told apart from options: a trailing `{ dropChecks: true }` is always read as the options object, so on an object with a field named `dropChecks`, `{ dropChecks: true }` means a call with no keys: `pick` keeps no field, `omit` drops none, and `partial` and `required` apply to every field. Write `pick('dropChecks')`.

`pick`, `omit`, `extend`, `partial` and `required` build a new object over the same field schemas, so retained fields keep their behaviour. A `refine`, `check` or `overwrite` declared on the object itself may read fields the new object lacks or makes optional, so on an object that has one these methods throw at declaration, naming the method and how many checks would be dropped. Say what you want with a last argument:

- `{ dropChecks: true }` on any of the five drops them: `range.pick('from', { dropChecks: true })`, `range.partial({ dropChecks: true })`, `range.required('to', { dropChecks: true })`.
- `{ keepChecks: true }`, on `extend` only, re-attaches them to the extended object in their declared order; they run against the extended value. Use it when the extension does not redefine a field the check reads.

`strict()`, `strip()`, `loose()`, `describe()`, `optional()` and `nullable()` derive no new shape and keep the checks. Checks on a field's own schema always travel with the field.

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
- Rejected on function `returns` when the validators are exported; the kit does not run return transforms. The error names the field that transforms (for example `field 'tags[].slug' uses transform or pipe`). A schema reused for both `args` and `returns` is the usual cause: declare `returns` with the output types instead, replacing the transforming field:

```ts
const input = k.object({ name: k.string(), slug: k.string().transform(toSlug) })
const output = input.omit('slug').extend({ slug: k.string() })
export const save = mutation({ args: input, returns: output, handler: … })
```

The type-preserving normalisers `trim`, `toLowerCase`, `toUpperCase` and `overwrite` are not transforms and are allowed everywhere, including table fields.

```ts
const args = { amount: k.string().regex(/^\d+$/).transform(Number) } // allowed in args
const fields = { title: k.string().trim() } // allowed in a table
```

There is no `coerce` or `preprocess`. Parse the raw value with a transform on an input-position schema instead.

A transform that can fail reports why through its second parameter, the same context `check` receives: `context.addIssue({ message, path?, code? })`, with `path` relative to the transformed value and `code` defaulting to `custom`. When it adds at least one issue the parse fails with those issues (at the value's location) and the return value is ignored; return `k.NEVER` (typed `never`, like Zod's `z.NEVER`) to say there is no value. Returning `k.NEVER` without adding an issue fails with `Invalid input`. A transform that throws still throws. The context is created only for a callback that declares a second parameter, so one-parameter transforms (including `Number` or `parseInt`) are called exactly as before.

```ts
const tags = k.string().transform((text, context): string[] => {
	const list: unknown = JSON.parse(text)
	if (!Array.isArray(list)) {
		context.addIssue({ message: 'Expected a JSON list' })
		return k.NEVER
	}
	return list.map(String)
})
```

## Fallbacks

`.catch(fallback)` is Zod 4's `catch`: when the schema reports issues, parse succeeds with the fallback instead. The fallback is a value, or a function receiving `{ issues, input }` (the issues the schema reported and the raw input). The fallback itself is not validated.

```ts
const role = k.enum(['admin', 'member']).catch('member')
role.parse('owner') // 'member'
const level = k
	.int()
	.min(0)
	.catch(({ input }) => (typeof input === 'string' ? input.length : 0))
```

- Types: output and input are the wrapped schema's, as in Zod 4. There is no `.unwrap()`; keep a reference to the wrapped schema.
- Native validators: the input side is `v.any()` (`v.optional(v.any())` when the wrapped schema is optional), because the fallback accepts any input; the output side is the wrapped schema's. Convex therefore validates nothing about the value, and at a function boundary the kit runs the wrapped schema's full structural check on it, not only declared checks.
- Allowed in args and `parse`. Rejected on table fields, on variant-table branch fields and in `returns`, like `transform`: the stored or returned shape would become `v.any()`. v1 converted `ZodCatch` to the wrapped validator (convex-helpers `zodToConvex`), so Convex rejected a bad argument before the fallback could apply; in 2.0 the fallback applies.
- Rejected around any `k.id`, at any depth (`k.id('users').catch(...)`, `k.object({ owner: k.id('users') }).catch(...)` throw at `.catch`, and `k.id(...).catch` is a type error): catch replaces Convex's argument validation for the value with `v.any()`, and the kit can check only that an id is a string; its table can only be checked by Convex. Catch the surrounding non-id fields instead, or validate the id in the handler with `ctx.db.normalizeId(table, id)`.
- Rejected on a discriminated-union option and on the discriminator field: dispatch needs the declared value. Put the catch on the whole union: `k.discriminatedUnion('kind', [...]).catch(fallback)`. A non-object given to a discriminated union is an `invalid_type` issue.
- `toJsonSchema` emits `{}` on the input side, where a caught field is not required (an absent value parses to the fallback). With `{ io: 'output' }` it emits the wrapped schema's shape without its checks (no length, range, pattern or format keywords), because the fallback is not validated against them. `toZod` throws on a schema holding `catch` (`.catch() is not carried`): `z.catch` would add about 10 KB of Zod core to every bundle of the interop entry. Convert the wrapped schema and add `z.catch` yourself.

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

Both are built on first read and memoised. With `skipConvexValidation: true` no native validator runs, so a `k.id` argument is only checked to be a string: its table is not verified. Use `ctx.db.normalizeId` in the handler when that matters. Native validators can sit next to `k` fields in function args (`{ id: k.id('t'), raw: v.string() }`); native fields are passed through untouched.

## Standard Schema

Every `k` schema implements Standard Schema v1 (`schema['~standard']`, vendor `cvx-kit`), and `validate` runs the same walker as `safeParse`. Contracts (`standardContract`) and form libraries that accept Standard Schema take `k` schemas directly.

Importing `cvx-kit/json-schema` also makes every schema implement Standard JSON Schema v1: `schema['~standard'].jsonSchema.input({ target })` and `.output({ target })` return the JSON Schema of `toJsonSchema(schema, { $schema: true, io })`, for `target` `'draft-2020-12'` or `'draft-07'` (any other target throws, as the spec asks). Libraries that read tool or form schemas through it, such as TanStack AI, then take `k` schemas directly. Pass `libraryOptions: { refs: true }` for `$defs` reuse. Without that import the property is absent, so the converter (about 10 KB unminified, 5 KB minified) stays out of function bundles that only use `k`; importing the entry for its side effect is enough:

```ts
import 'cvx-kit/json-schema' // once, in the module that hands schemas to the AI library
```

## JSON Schema

`toJsonSchema(schema, { $schema?, io?, refs? })` from `cvx-kit/json-schema` emits draft 2020-12 JSON Schema of the input side: optional and defaulted fields are not required (a JSON-compatible default is emitted), ids are strings, ISO dates carry `format: 'date'` or `'date-time'`, descriptions come from `.describe()`, transforms emit their input schema, and plain or strict objects have `additionalProperties: false` to describe their closed boundaries. Explicit `.strip()` and `.loose()` omit that restriction on the input side. Repeated bounds keep the strongest one (`.min(2).min(5)` emits `minLength: 5`), and several `regex` checks emit the first as `pattern` and the rest as `allOf` patterns. Timestamps carry `maximum: 253402300799999`. `.positive()`/`.negative()` emit `exclusiveMinimum`/`exclusiveMaximum`, and `k.int()`/`.int()` emit `type: 'integer'` with the safe range as `minimum`/`maximum` (a tighter `.min()`/`.max()` replaces it), so `.safe()` is redundant there too. Custom refinements are omitted.

`{ io: 'output' }` describes what parse returns instead, as Zod's `io` option: a defaulted field is required, a pipe emits its target's output, and a transform emits `{}` (any value), as `outputValidator` emits `v.any()`. The entry is separate, so function bundles that do not import it do not load it.

`{ refs: true }` emits a sub-schema that occurs more than once (the same object, array, record or union schema instance) once under `$defs` and points to it with `$ref` (`#/$defs/s0`, …); `draft-07` output through `~standard.jsonSchema` uses `definitions`. A contract that repeats a relation filter or DTO schema in many places stays small this way. It is off by default so existing output does not change; scalar schemas such as `k.string()` are shared instances and are never moved into `$defs`.

```ts
import { toJsonSchema } from 'cvx-kit/json-schema'

const inputSchema = toJsonSchema(documentInput)
const outputSchema = toJsonSchema(documentInput, { io: 'output' })
```

## Zod interop

`cvx-kit/zod` converts a `k` schema to Zod 4 for libraries that only accept Zod. Install `zod` (an optional peer) to use it. By default the result is a `zod/mini` schema: it has `parse`, `safeParse` and `check`, works with any library that accepts a Zod 4 schema, and converts back through convex-helpers' `zodToConvex`. It does not have the classic chain methods (`.optional()`, `.extend()`); extend it with the `zod/mini` functions (`z.optional(schema)`, `z.extend(schema, shape)`).

Import the classic entry to get a classic Zod schema with chain methods:

```ts
import { toZod } from 'cvx-kit/zod/classic'

const classicSchema = toZod(documentInput)
const optional = classicSchema.optional()
```

The classic entry uses named constructors so bundlers can remove unused Zod exports. In the bundle test, a one-field schema uses 219,220 Zod bytes, including English error messages but no other locales. The Mini entry uses 79,065 bytes with no locales. Passing the whole namespace uses 771,692 bytes in that test; a consumer measured 754 KB. The deprecated `toZod(schema, { zod: z })` option from `cvx-kit/zod` still works, but passing the namespace keeps all of Zod in the bundle. Importing `cvx-kit/zod` installs `.toZod()` on every schema; that method continues to return Mini output.

Carried: structure, object policies (plain `k.object` and `strip()` objects convert to stripping `z.object`, `.strict()`/`k.strictObject` to `z.strictObject`, `loose()` objects convert to `z.looseObject`, `k.jsonObject()` to `z.record(z.string(), z.json())` with Convex's key rule on its top-level keys only; nested keys are not checked), ids with their table typing (an id converts to `z.string()`, typed as the table's `Id`, with its table name recorded in the exported `kZodIds` registry: `kZodIds.get(schema)?.tableName`; convex-helpers' `zodToConvex` sees it as a plain string), `min`, `max`, `length`, `regex`, `int`, `trim`, case normalisers, defaults, ISO date formats, timestamps (with their range), descriptions, and `refine`, `check`, `overwrite`, `transform` and `pipe`, nested ones included. A converted schema runs the same callbacks as `k` `parse`; a `k.custom` guard is a `refine`, so it is carried too. Three differences come from Zod itself and remain: Zod's number rejects `NaN` and `Infinity` where `k.number()` accepts them unless `.finite()` is declared, `z.any()` (the converted `k.custom`) accepts `undefined` where `k` refuses it, and a Zod union takes its first matching member where `k` prefers a member that accepts every key. A default converts to Zod's `prefault`, so it runs through the rest of the chain as in `k`; a default declared above a transform or pipe converts to Zod's `default`, because it supplies parsed output. A `partial()` field carries no default. `k.void()` converts to a union of `null` and `undefined`. Not carried: `catch`, which throws (`.catch() is not carried`); convert the wrapped schema and add `z.catch` yourself. Conversion is one way: there is no Zod → `k` conversion. Importing `cvx-kit/zod` puts Zod's core into that bundle (under 80 KB unminified), so keep it out of Convex function modules that do not need it. Calling `.toZod()` without importing the entry throws an error that names the entry.

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
