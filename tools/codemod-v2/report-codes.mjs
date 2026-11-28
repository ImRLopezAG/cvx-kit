// Fix sentences shared by the JSON report and text summary. The guide table is checked in tests.
export const REPORT_FIXES = {
	catchall: 'Decide per site; see [No v2 form](#constructs-with-no-v2-form).',
	catch: 'Read `input` and `issues` instead; `k` passes `{ issues, input }`.',
	recursive: 'Restructure the data.',
	tuple: 'Use an object or a checked array.',
	custom: 'A structural schema plus `.refine`, or `k.custom<T>(guard)`.',
	coerce: 'An input-position `.transform`.',
	'super-refine': 'Rewrite as `.check((value, ctx) => ctx.addIssue({ message, path }))`.',
	'transform-issue': 'Use `ctx.addIssue({ message, path?, code? })` and `return k.NEVER`.',
	meta: '`.describe(text)`.',
	brand: 'Remove; brand in app types if needed.',
	'string-format': '`k.string().regex(...)`.',
	'iso-options':
		'`k.isoDateTime()`/`k.isoDate()` take no options; add a `.regex` or `.refine` for the rule you need.',
	'void-position': 'Make the field `.optional()`; use `k.void()` only in `returns`.',
	'enum-unproven': '`k.enum` of string values; for numbers, a `k.union` of `k.literal`s.',
	'enum-runtime-checked': 'Nothing, unless the list can hold a non-string.',
	'enum-options': 'Drop the options, or put the message on a `.refine`.',
	'normalize-options': '`.overwrite((value) => value.normalize(form))`.',
	'string-prefix':
		'`.regex(/^prefix/)` with the prefix escaped, or `.refine((value) => value.startsWith(prefix))`.',
	'json-schema': '`toJsonSchema` from `cvx-kit/json-schema`.',
	'unknown-factory': 'Pick the `k` factory by hand.',
	'unknown-method': 'Use the [Zod to `k` map](#zod-to-k-map).',
	'zod-check': 'Rewrite as `.check((value, ctx) => ctx.addIssue({ message }))`, then run again.',
	'error-map': "Replace it with `message: '…'`; `k` has no error maps.",
	'type-helper-unknown':
		'Migrate that schema (or pass its file in the same run), then run again; or keep it Zod.',
	'derive-drops-checks':
		'Pass `{ dropChecks: true }`, or `{ keepChecks: true }` on `extend`; see [Derived objects](#derived-objects-refuse-to-drop-object-level-checks).',
	'unproven-mask': 'Pass string keys if it is a `k` schema; `k` throws on a mask object.',
	'mask-dynamic': 'Pass string keys.',
	'partial-record-key':
		'`k.record(k.string(), v)` for string keys, `k.partialRecord(k.enum([...]), v)` for finite keys.',
	'table-callback-complex': 'Write the field object by hand with `k.id(...)`.',
	'zod-type': 'Use `KType` or the `k` schema types from `cvx-kit/k`, or `k.infer`.',
	'zod-introspection': 'Read `result.issues`.',
	'zod-interop': 'Use `k.id`, `schema.validator` or `toZod`.',
	'zod-to-convex-unknown':
		'`x.validator` once `x` is `k`, or keep the convex-helpers import for a Zod schema.',
	'convex-to-zod':
		'For a `k` schema use `toZod(schema)`; for a native validator import `convexToZod` from `convex-helpers/server/zod4`.',
	'zid-in-zod-statement':
		"Rewrite the statement to `k.id('table')`, or keep it in Zod with the moved import.",
	'zid-value': 'Replace with `k.id` usage by hand.',
	'held-pipe-to-k':
		'Fix the reason the statement is held, then run again, or convert the pipe target back with `toZod`.',
	'zod-consumer':
		'Keep it, or move the schema to `k` and pass `toZod(schema)`; see [Schemas shared with Zod libraries](#schemas-shared-with-zod-libraries).',
	'zod-consumer-import':
		'Wrap the argument: `toZod(schema)`, or `toZod(schema)` from `cvx-kit/zod/classic` for classic Zod.',
	'zod-consumer-unproven': 'Check the builder; if it takes Zod, pass `toZod(schema)`.',
	'v1-entry-string': 'Update the string to the v2 name.',
	'keep-zod-marker': 'Nothing, unless the file should migrate: remove the marker.',
	'mixed-reference': 'Fix the referenced statement first, then run again.',
	'k-shadowed': 'Rename the local binding, then run again.',
	'k-conflict': 'Rename that binding, then run again.',
	'package-without-cvx-kit':
		'Limit the paths, add the intended dependency, or pass `--include-packages-without-kit`.',
	'bytes-validator-narrowed': 'Check callers send an `ArrayBuffer`; diff the function spec.',
	'number-finite-preserved': 'Nothing; or run with `--native-number-bounds`.',
	'number-now-accepts-nan': 'Add `.finite()` where the value must be finite.',
	'check-options-by-reference':
		'Nothing for a string `error`; replace a function-valued `error` with `message`.',
	'table-spread': 'Nothing; the spread builds every boundary of that table.',
	'strict-on-reference': 'Add `.strict()` to the `k` schema by hand.',
	'strict-unpaired': 'Find the object and add `.strict()` by hand.',
	'strict-ambiguous': 'Decide by hand from the reported base line.',
	'strict-now-other-policy': 'Decide by hand.',
	readonly: 'Remove the wrapper or enforce immutability in application code.',
	preprocess: 'Use an input-position `.transform` from the raw schema.',
	codec: 'Transform input and encode output in the handler.',
	file: 'Store an uploaded file reference or validated bytes instead.',
	'template-literal': 'Use a string schema with a regular expression.',
	'zod-foreign-schema':
		'Migrate the source schema, keep a Zod function builder, or bridge with `zodToConvex` and parse in the handler.',
	'table-type-arguments':
		'Use element unions for server, client and public field keys and check the table signature.',
	'refine-async': 'Move async validation into the handler and keep schema refinements synchronous.',
	'literal-array': 'Use a union of scalar literals or rewrite a string list as `k.enum`.',
	'factory-params':
		'Remove the factory options explicitly or express the rule with a supported check.',
	'iso-datetime-offset': 'Add `.regex(/Z$/)` when only UTC timestamps are allowed.',
	'normalise-before-check': 'Check the intended rule because k normalises before running checks.',
	'union-member-order': 'Check overlapping members and use a discriminator when selection matters.',
	'record-key-rule':
		'Check maps for keys starting with `_` or `$`, non-ASCII keys and keys longer than 1,024 characters.',
}
