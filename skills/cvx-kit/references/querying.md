# `cvx-kit/querying` — typed, authorized stream pagination

For a field containing IDs from several tables, see
[native-ID union relations](./native-id-relations.md).

Declare relationships with `cvx-kit/relations`, configure one query engine, then
paginate with a small declarative chain. The engine runs streams and relationship
lookups in the caller's Convex query transaction. Filtering determines eligible
parents before they fill a page. Native `paginated(dto)` remains independent.

## Browser-safe scalar filters

Declare selected fields in a pure module with `cvx-kit/filters` and
`convex/values`; import that module from both the browser and the stored table.
Keep the live relation registry in server code.

```ts
// contracts/task-filters.ts (browser safe)
import { v } from 'convex/values'
import { defineFilterContract } from 'cvx-kit/filters'
export const taskFilters = defineFilterContract({
	status: v.union(v.literal('open'), v.literal('done')),
	dueAt: v.optional(v.number()),
	assignee: v.id('users'),
})
// server table declaration
const tasks = zodTable('tasks', () => ({ ...taskFilters.fields, secret: z.string() }))
const relations = defineRelations({ tasks }, () => ({}))
const args = relations.tables.tasks.filters(taskFilters)
const list = authQuery({
	args,
	returns: relations.tables.tasks.pageDto({}),
	handler: (ctx, input) => querying(ctx).tasks.paginate(input),
})
```

Binding checks native field types, ID table names and optionality, and uses the
exact shared filter schema in the pagination input. Kit table/auth constructors
preserve native ID validation; browser validation checks ID strings and retains
their output brands. Do not register the pure ID schemas directly through
convex-helpers' server constructors: its private ID registry cannot recognize
them. Existing `paginationOpts(selection)` keeps its relation/variant grammar.
The shared contract is scalar only: unsupported objects, arrays and variant
tables are explicitly rejected, as are relation/variant filter expressions.

`schema` validates direct fields, `fields`, `and`, `or`, `not` and native scalar
operators under the same depth/node/in-value ceilings. `describe()` reports
literal enum values, unions, ID tables, nullable/optional and bigint metadata.
Number fields have no implicit date semantics; finite numbers follow legacy
Zod validation. Bytes are outside this scalar grammar.

`searchParam.encode(filters)` and `.decode(text)` return either
`{ success: true, value }` or `{ success: false, error }`. Version 1 uses Convex
value serialization, preserves bigint and array order, and sorts object keys.
Inputs are bounded to 32,768 encoded characters, four expression edges and 256
grammar nodes. Getters, cycles, malformed versions and invalid values reject.

`evaluate(filters, document, accessibleFields)` returns `true`, `false` or
`'unknown'`. The set lists accessible fields even when their stored value is
missing. A field outside that set stays unknown through negation and boolean
composition unless another branch decides the result. Omit the set only for a
complete server row; inaccessible fields must never be treated as missing.

## Stored field groups

Register whole stored fields alongside the table boundary. The registry captures
their native schemas and membership; overlapping groups, public fields, unknown
fields and incompatible variant containers are rejected. A group can contain a
field present in only some variant branches. It never runs a private stored
transform or widens the public DTO with unrelated fields.

```ts
const relations = defineRelations(
	{
		clients: { ...clients, fieldGroups: { finance: ['balanceCents'] } },
		grants,
	},
	() => ({}),
)
const querying = createQueryEngine(
	{ schema, relations },
	{
		fieldGroups: {
			clients: {
				finance: async ({ db, scope }) => {
					// scope comes from the registered managed authority, never request args.
					const grant = await db
						.query('grants')
						.withIndex('by_user', (q) => q.eq('user', scope.principal ?? ''))
						.first()
					return grant?.finance === true
				},
			},
		},
	},
)
const page = await querying(ctx).clients.include({ finance: 'if-permitted' }).paginate(args)
const returns = relations.tables.clients.pageDto(
	{},
	{
		fieldGroups: { finance: 'if-permitted' },
	},
)
```

Register policy dependency tables too. Policy readers share managed budgets and
row authorization; use bounded operations such as `get`, `first` or `take`.
Policies receive only trusted `scope` and the metered `db`, and must return
`true` to grant access. Missing policies deny. Decisions are cached once per
engine request/table/group, and re-evaluated on every new request. Engine
creation captures policy callback references; callback closure state remains
application-owned live state.

`required` preserves stored field types and throws `FieldGroupError` with fixed
code/message `FIELD_GROUP_DENIED` on denial. `if-permitted` makes the fields
optional: denial omits own keys, never substitutes null. Stored nullable and
optional fields retain their native semantics. No opt-in exposes no group keys.
Use the same modes in `pageDto(selection, groupOptions)` and the query chain.
Existing `pageDto(selection)` remains valid.

Keep existing relation selection in the first argument and target group options
in the second. Names in `relations` below are declared relation names; group
names stay in `fieldGroups`, even when a relation and group share a name.

```ts
const groups = {
	fieldGroups: { finance: 'required' },
	relations: { accounts: { fieldGroups: { finance: 'if-permitted' } } },
} as const
relations.tables.clients.pageDto({ accounts: true }, groups)
querying(ctx).clients.with({ accounts: true }, groups).paginate(args)
// Each target evaluates its own policy, including standalone continuations.
querying(ctx)
	.clients.relation(parent, 'accounts')
	.include({ finance: 'if-permitted' })
	.paginate(args)
```

`include` replaces the root group request and preserves relation group options.
`with` replaces relation output selection and merges the provided top-level group
options. A relation chain starts with its target's own group request.
For direct many ancestors, nested continuation verifies each named ancestor by
authorized ID lookup and its current parent link. It does not repeat the ancestor's
sorting or projection, so it needs no ancestor field-group grant. Current row
permission and the final target's requested group policies still apply.

Continue to select filter fields explicitly with `paginationOpts(selection)`.
The engine checks the complete client predicate tree (including not/or, variants
and relation targets) before traversal. Protected predicates and ordering require
an allowed, requested group, even for an empty or contradictory query. Fixed
server constraints stay trusted and do not authorize client predicates. Both
cursor navigation slots bind requested modes and decisions; revocation rejects
old cursors. Public error-envelope transport helpers belong to the separate
error-contract API; the direct error class alone is not a transport guarantee.

## Declare tables and indexes

Keep shapes in `domain/<module>/schema.ts` and native indexes in its `table.ts`.
These examples put tasks, labels, and their junction in one owning module.

```ts
// convex/domain/tasks/schema.ts
import { z } from 'zod'
import { zodTable } from 'cvx-kit/zod-table'

export const tasks = zodTable(
	'tasks',
	(id) => ({
		title: z.string(),
		department: z.string(),
		status: z.string(),
		priority: z.number(),
		reference: id('tasks').nullable().optional(),
	}),
	{ publicFields: ['title', 'department', 'status', 'priority'] },
)

export const labels = zodTable(
	'labels',
	() => ({
		name: z.string(),
	}),
	{ publicFields: ['name'] },
)

export const edges = zodTable(
	'edges',
	(id) => ({
		task: id('tasks'),
		label: id('labels'),
	}),
	{ publicFields: [] },
)
```

```ts
// convex/domain/tasks/table.ts
import { tasks, labels, edges } from './schema'

export const tables = {
	tasks: tasks.table.index('by_department_status', ['department', 'status']),
	labels: labels.table,
	edges: edges.table.index('by_task', ['task']),
}
```

Assemble those table definitions in the application's root schema. Declare every
index used by a relationship before compiling the relation registry.

## Declare relationships once

```ts
// convex/relations.ts
import { defineRelations } from 'cvx-kit/relations'
import './domain/tasks/table'
import { tasks, labels, edges } from './domain/tasks/schema'

export const relations = defineRelations({ tasks, labels, edges }, (r) => ({
	tasks: {
		referenceTask: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }),
		labels: r.many.labels({
			from: r.tasks._id.through(r.edges.task),
			to: r.labels._id.through(r.edges.label),
		}),
	},
}))
```

A direct one edge uses `r.one.target({ from, to })`; a direct many edge uses
`r.many.target({ from, to })`. For example, with a stored `labels.task` foreign
key and a supporting `by_task` index on labels:

```ts
r.many.labels({ from: r.tasks._id, to: r.labels.task })
```

Relationship names distinguish multiple references to the same table. Self
references and junctions are supported. Tables can be `zodTable`, `tenantTable`,
or the three-argument `zodVariantTable` boundaries. Declarations
are validated against table ownership, field compatibility, and supporting
indexes. Convex does not infer relationships; this registry supplies them.

`defineRelations` captures table names, stored field semantics, public DTO
validation, variants, active indexes, and relation declarations before invoking
the declaration callback. Complete schema and index configuration before calling
it. Later changes to source declarations do not affect existing registries,
helpers or engines. Create a new registry to adopt changes. Caller-owned
declarations remain mutable. Each returned schema helper owns its validation
graph; editing one helper does not change other helpers or private engine parsers.

Relation DTOs support `.refine()`, including captured callback references and
copied check definitions. They reject opaque `.superRefine()` and `.check()`
callbacks at registration; express those validations with `.refine()` instead.
Application state accessed by callback closures remains live.

For branch-specific joins, filters, and a complete variant endpoint, see
[Variant querying](./variant-querying.md). Common compatible fields use the same
references shown above; branch references carry a discriminator guard.

## Configure the engine and authentication

```ts
// convex/querying.ts
import { createQueryEngine } from 'cvx-kit/querying'
import schema from './schema'
import { relations } from './relations'

export const querying = createQueryEngine({ schema, relations })
```

The application's `functions.ts` facade configures `createAuthFunctions`,
including its membership resolution and effective read/tenancy policies. Call
`querying(ctx)` with a query context supplied by that facade's `authQuery`.
The engine consumes the private managed reader capability installed there and
rechecks composed authorization for parents, junctions, targets, and continuation
reads. The example declarations do not establish access policy on their own.
See [auth.md](./auth.md) and [tenancy.md](./tenancy.md) for policy setup.

Unknown contexts fail closed with `UNMANAGED_QUERY_CONTEXT`. Mutation and action
contexts are unsupported. A host with another auth system can centrally configure
`trustedAdapter`; it must attest the query reader, effective policy, and security
scope. Do not expose adapter selection to endpoint arguments.

Declare this engine once at module scope. It serves every registered table;
`querying(ctx)` binds authorization and read accounting to the current request.
Table fields, indexes, DTOs, and relationship metadata come from the schema and
relation registry. No per-table engine declaration is needed.

The engine loads cursor keys internally when pagination first runs. Set
`CVX_QUERY_CURSOR_KEYS_JSON` to a JSON object mapping key IDs to 128 hexadecimal
characters (64 secret bytes), and `CVX_QUERY_CURSOR_CURRENT_KEY_ID` to the ID
used for new tokens. These are server environment variables, shared by all
tables. Generate real secrets outside query execution and configure them through
Convex environment settings; never put them in client arguments, source, or logs.
Keep prior keys during rotation to preserve existing cursors. Changing environment
configuration requires the engine to reload with the new deployment configuration.

Engine declaration and auth registration do not read these variables. Missing or
invalid configuration fails pagination before database reads. The codec's format
version is internal. It uses authenticated AES-SIV encryption with no plaintext
fallback; identical bound payloads reveal equality.

## Define input and result contracts

```ts
// Inside convex/domain/tasks/contracts.ts
const input = relations.tables.tasks.paginationOpts({
	department: true,
	status: true,
	priority: true,
	referenceTask: { status: true },
	labels: { name: true },
})
const result = relations.tables.tasks.pageDto({
	referenceTask: true,
	labels: true,
})
```

`paginationOpts(selection)` extends native Convex pagination options with optional
`filters` and global `order: 'asc' | 'desc'`. The selection permits client filters;
it does not change public output or grant access. The result selection must
match `.with(...)`. `.pageDto({})` returns a native page of the table's public
DTOs including branded `_id`. One relationships return a public DTO or `null`;
many relationships return their own bounded native pages. Missing and unreadable
targets have the same public result. Duplicate junction occurrences remain in
output, even when target reads are memoized.

For scalar-only input, use `tasks.paginationOpts({ status: true })`. Both forms
are Zod objects and support `.extend(...)` for endpoint-specific arguments.
Use the contracts through your domain Query registry and keep public auth
registration in `api/<entity>.ts`; see [domain-contracts.md](./domain-contracts.md).

## Query and filter

```ts
// Inside an authenticated domain Query handler
const department = args.filters?.department
const indexCondition = typeof department === 'string' ? department : undefined
const page = await querying(ctx)
	.tasks.where({ status: 'open' })
	.when(indexCondition, 'by_department_status')
	.with({ referenceTask: true, labels: true })
	.paginate(args)
```

`.where(spec)` adds server-owned constraints, combined with client filters by
AND. Use it for mandatory business constraints; effective auth policy still
controls access. `.with(selection)` chooses related output. A relation can be
used as an eligibility filter without also including it in output. A parent
relationship predicate does not filter the nested output page: it determines
whether the parent is eligible. Child-page filters are a separate query input.

Example client args for the contract above:

```ts
{
  numItems: 25,
  cursor: null,
  order: 'desc',
  filters: {
    department: 'engineering',
    priority: { gte: 2, lt: 5 },
    labels: { some: { name: 'urgent' } },
    not: { status: 'blocked' },
  },
}
```

Scalar predicates accept direct equality or operator objects with `eq`, `in`,
and, for supported range types, `gt`, `gte`, `lt`, and `lte`. Optional fields
also support `exists`. `and` and `or` contain nonempty arrays of predicates;
`not` contains one predicate. Use `fields: { ... }` to address scalar fields
whose names collide with grammar keys such as `and`, `or`, `not`, or `fields`.
One relationships accept a nested predicate or `null`; many relationships use
`some` or `none` over authorized targets. Unknown fields and incompatible scalar
values/operators fail validation. Filter depth is at most four, the whole tree
has at most 256 nodes, and an `in` list contains at most 100 values.

## Conditional indexes and ordering

`.when(value, 'index_name')` selects the first present condition. `false`, `0`,
and `''` are present; `null` and `undefined` are absent. The condition chooses an
index but does not bind its fields: validated filters and `.where(...)` supply
the bindings. An incompatible explicit index fails instead of silently scanning.
Relationship traversal retains its mandatory foreign-key prefix.

`.orderBy('index_name')` selects a schema-declared index without requiring an
equality prefix. It returns a new chain; repeated calls replace the selection.
Matching leading equalities narrow the scan, while non-prefix predicates remain
residual. Index names come from the native schema's index builder return types:
retain the indexed table returned by `.index(...)` when declaring the schema.
Unknown runtime names fail before reads. An active `.when(...)` and `orderBy`
cannot be combined; nullish conditions remain inactive.

```ts
await querying(ctx)
	.tasks.orderBy('by_department_dueAt')
	.where({
		department: 'sales',
		dueAt: { gte: start, lt: end },
	})
	.paginate({ numItems: 25, cursor: null, order: 'desc' })
```

Without an explicit choice, the planner selects the longest usable equality
prefix, then a usable range, then stable index-name ordering; otherwise it falls
back to creation time. Common OR equalities retain their existing behavior.
AND-guaranteed bounds on the next index field after that prefix (or the first
field with no equality) become native lower/upper bounds. The tightest endpoints
win, with strict bounds winning ties. Contradictory bounds or equality conflicts
return no candidates. Bounds under OR/NOT and beyond an unbound index gap remain
residual. Every predicate also remains checked after authorization.

`order: 'desc'` reverses the complete selected index order, including native ties.
Both continue and end cursors bind the chosen index, direction and filters.
Optional fields retain native scalar comparison semantics: upper bounds can match
missing values; no null/existence guard is added. Use `exists: true` when needed.
Nullable fields keep their existing grammar, which rejects range operators; null
and missing values still retain their native index order and equality behavior.

Guaranteed `in` filters and OR expressions consisting only of equalities on the
same field can expand one consecutive index position into up to eight unique
ranges. Values are deduplicated and sorted using Convex ordering. No Cartesian
product is built for multiple sets. An empty `in` returns an empty page.

With explicit `orderBy`, the comparator includes the **full index**, including
the expanded field. Automatic expansion merges by the remaining index tail,
then native `_creationTime`/`_id` ties. For example, automatic status expansion
interleaves creation times; `orderBy('by_status')` groups by status first.
Both honor `order: 'asc' | 'desc'`. Range bounds on the immediately following
field push down into every value's range; all predicates still run after auth.

The expansion ceiling of eight is independent of managed `indexRanges`.
An eligible automatic plan above eight throws `QUERY_FANOUT`; it never silently
changes comparator. Explicit full-index ordering may instead scan the same
index with a residual set predicate. Other OR expressions remain residual.
Direct relationships expand only lookup-compatible indexes; junction traversal
retains its existing edge order and multiplicity. Explicit ordering across any
junction remains unsupported and fails before reads.

Protected cursors bind the normalized set, comparator and plan mode with a new
traversal semantics version. Duplicate/permuted values can resume the same
query; changing the set rejects its cursor. Each merged input may prefetch one
candidate. These reads, authorization dependencies and every active iterator
share the request budget and cleanup; rows read can exceed rows returned.

For relation continuations, `orderBy` supports only direct paths whose target
index is compatible with the mandatory lookup equality prefix. Incompatible
indexes and every junction/through path reject before parent or candidate reads.
Junction pages retain their existing traversal order and repeated edge occurrences;
they do not provide global target ordering. Range bounds are recomputed against
each actual lookup prefix and never copied from target fields to junction rows.

## Continue relationship pages

Return many relationships as pages, then use a separate authenticated endpoint
for their next page. Validate `parent` with `tasks.schema.shape._id` and use the
related table's pagination contract:

```ts
const input = relations.tables.labels
	.paginationOpts({ name: true })
	.extend({ parent: tasks.schema.shape._id })
const result = relations.tables.labels.pageDto({})

// Inside the child Query handler
const { parent, ...options } = args
return querying(ctx).tasks.relation(parent, 'labels').paginate(options)
```

The client sends the parent ID and the nested page's `continueCursor`, preserving
its original order and output selection. For the parent example above that means
`order: 'desc'`, selection `{}`, and no child filters on resume; adding a `name`
filter would change the binding and reject that cursor. A new child traversal
with `cursor: null` can establish its own filters. Typed
paths can traverse several declared edges to a many relationship. Each request
rechecks the parent path and current authorization; a child token cannot be
replayed under another parent.

Root, child, split, and end cursors bind filters, output selection, index, order,
ancestry, principal/tenant/security scope, and registry/policy/engine versions.
Changing page size alone remains valid. Treat tokens as opaque; preserve native
`isDone`, `continueCursor`, and optional page-status/split metadata. Permission
changes are rechecked on resume. Native `endCursor` supports bounded partitions.

## Central limits and operational behavior

The engine supplies default limits and cursor compatibility versions. Normal
applications need only `{ schema, relations }`. Optional central overrides belong
in the second argument:

```ts
export const querying = createQueryEngine(
	{ schema, relations },
	{
		maxPageSize: 50,
	},
)
```

| Option           | Purpose                                                                | Default setup                                               |
| ---------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `budgets`        | Lower shared read, byte, fan-out, depth, and memo ceilings             | Engine defaults                                             |
| `maxPageSize`    | Lower the 100-item page ceiling                                        | 100                                                         |
| `policyVersion`  | Invalidate old cursors after a policy semantic change                  | Internal default; current authorization is always rechecked |
| `engineVersion`  | Override the engine compatibility identity                             | Internal default                                            |
| `trustedAdapter` | Connect another auth system's query reader and policies                | Managed auth capability from `cvx-kit/auth`                 |
| `cursor`         | Supply an explicit key ring, for custom secret management or migration | Server environment loader                                   |

These are application-wide overrides, never endpoint arguments. Existing
one-argument declarations with these fields still work for compatibility; move
those fields to the second argument when migrating. To preserve pre-migration
cursors, keep the existing explicit cursor version and key ring until those
cursors have expired.

Browse page sizes are positive integers up to 100. Shared request budgets cover read
operations, index ranges, raw candidates, document bytes, fan-out, traversal
depth, and memo entries, including managed policy reads. Native request read
limits may lower ceilings. Output relationship depth is at most four.

Engine pages include optional `completeness`: `complete`, `row-budget`,
`byte-budget`, `native-limit`, or search-only `result-cap`.
`complete` describes the requested page or end-cursor interval; use `isDone`
to determine global exhaustion. A full requested page can be complete while
`isDone` is false or native split metadata is present. Managed read-operation
and raw-candidate stops report `row-budget`; byte reservation stops report
`byte-budget`. The helper's combined row/byte limit reports `native-limit`.
The first boundary that actually stops iteration wins; merely consuming the
last available reservation does not mark a full page incomplete. Simultaneous
managed row and byte admission failures check rows first.

Pass `onEmptyBudget: 'split'` to `.paginate(...)` (also accepted by table and
relation `paginationOpts(...)` schemas) to explicitly request safe empty
progress. Existing all-denied and residual-rejected pages already advance by
default and retain that behavior. Only fully processed candidate keys advance:
an empty budget split stays `isDone: false` and provides protected continuation
and split cursors. Keep loading from `continueCursor`, or use the usual split
intervals. No-progress, unfinished policy/related reads, and DTO validation
failures still throw, including when this option is set.

If eligibility cannot be established within the budget, execution throws
`MANAGED_READ_BUDGET`; it does not return a misleading exhausted page or conclude
that a negative relationship predicate matched. Policy errors propagate rather
than turning into eligible rows. Memoization is request-local and preserves
junction multiplicity. Relationships can require many database reads; one public
query does not imply one physical read. Document accounting is an application
bound, not a measurement of Convex storage/index/prefetch I/O.

Arbitrary async predicates, custom projections/sorts, mutation/action execution,
vector search, and global caching are outside this API. Index
selection reduces candidates where possible; filtering every supported scalar
field does not guarantee an efficient index for every filter combination.

## Root full-text search

Register the native `.searchIndex('search_text', { searchField: 'text',
filterFields: ['status'] })` table object in both the schema and relation registry.
Only declared, nonstaged indexes are accepted. Search text must be nonblank;
results retain native relevance order. Index filter equalities can reduce native
candidates; other supported filters run as residual eligibility checks.

```ts
const selection = { labels: true } as const
const result = relations.tables.tasks.pageDto(selection)
 .and(z.object({ paginationMode: z.literal('native-search') }))
const run = (ctx, input) => querying(ctx).tasks
 .search('search_text', input.text)
 .where({ status: 'open' })
 .include({ finance: 'if-permitted' })
 .with(selection)
 .paginate({ numItems: 25, cursor: input.cursor, scanLimit: 250 })

// Ordinary registered authQuery boundary:
const search = authQuery({ args, returns: result, handler: async (ctx, input) => {
 try { return await run(ctx, input) }
 catch (error) { throw new ConvexError(queryFailureContract.project(error)) }
} })
```

Import `ConvexError` from `convex/values` and `queryFailureContract` from
`cvx-kit/querying`. With `createEffectAuthFunctions`, configure
`query: { errors: queryFailureContract }` and return
`Effect.tryPromise({ try: () => run(ctx, input), catch: error => error })`.
Do not throw a pretransported foreign envelope through a different Effect error
policy. Declared search admission failures and invalid cursors carry fixed codes;
the admission codes are `SEARCH_TEXT_REQUIRED`, `SEARCH_END_CURSOR_UNSUPPORTED`,
`SEARCH_ORDER_UNSUPPORTED`, `SEARCH_RELATION_UNSUPPORTED`,
`SEARCH_OPTIONS_UNSUPPORTED`, and `SEARCH_PROTOCOL_UNSUPPORTED`.
Unknown policy/DTO exceptions become `{ _tag: 'UnknownFailure', version: 1 }`,
without private messages, IDs or partial rows. Direct engine callers retain native errors.

Search is a root entrypoint. `.with(...)`, `.include(...)`, existing scalar and
relationship predicates and their authorization checks remain supported. Direct
`.relation(...).search(...)`, `.search(...).relation(...)`, `.orderBy(...)` and
active index `.when(...)` selection are unsupported. Search accepts no nonnull
`endCursor`, `order`, `maximumRowsRead`, `maximumBytesRead`, or `onEmptyBudget`.
There is exactly one native search pagination call per admitted request, no
refill to compensate for denied/residual-rejected rows, and no engine splits.
`splitCursor` and `pageStatus` are null; the root has
`paginationMode: 'native-search'`. Nested many pages retain browse semantics and
can be resumed through authenticated relation endpoints; they have no search marker.

For a new window, the native initial target is the minimum of requested
`numItems`, central `maxPageSize`, `budgets.searchCandidates`, and the remaining
`scanLimit - seen` when configured. It is a positive integer target, not a bound
on a reactive window's actual raw row count. Live native windows can grow beyond
that target. Search processes every actual raw row, including denied rows, before
issuing an authenticated continuation carrying the new branch-local `seen` count.
`scanLimit` is an admission threshold, not an exact live quota: seen 6 plus an
actual five-row window under limit 9 yields seen 11, retains every authorized row,
and returns `isDone: true`, `completeness: 'result-cap'`. A capped input admits no
new native call. Cap completion does not assert database exhaustion. Replaying an
old input repeats its branch; page-size changes do not reset seen or create a global quota.
Tokens bind text/index, filters, selection/groups, cap, principal/security scope
and engine/registry versions. Role, text or cap changes require a new chain.

Root raw payloads use a separate search accounting contract: `searchCandidates`
limits the initial target; actual root candidate counts and payload bytes are
observed separately, without imposing the browse raw-candidate/byte ceilings on
a live root window. Convex platform limits still apply. Root raw rows do not
consume the browse raw-candidate/byte ledger merely for being search results. Policy reads, relationship eligibility/output and all
secondary reads still share managed read-operation, index-range, raw-candidate,
byte, memo, depth and fan-out budgets across the request. Search candidate and
byte counters do not grant separate nested budgets. A nested budget stop before
its requested page is fulfilled aborts the entire root page, including a nested
browse executor's otherwise-partial split. A fully fulfilled nested page with
more data can succeed with its browse continuation. Policy/DTO/deeper-descendant
failures also abort atomically: no partial root page and no newly minted cursor;
retry the original input after remediation.

A short or denied-empty page with native `isDone: false` remains loadable. Always
continue from `continueCursor` manually, independent of `page.length`:

```ts
const next = page.isDone ? null : page.continueCursor
// One explicit user action loads the next window; no automatic empty-page loop.
```

For React, use `usePaginatedList` with a public `paginationOpts` endpoint. Preserve
all already-loaded child inputs while SDK-owned opaque journals track live window
boundaries. Do not decode journals or replace child input cursors with rerun parent
output tokens. An earlier window reaching cap retains loaded children; only the
tail determines further continuation. See [reactive lists](client-list.md).

## Migration and verification

Use `toPublicDto(row, true)` with `dto(true)` instead of manual ID spreads.
Replace copied pagination schemas with table/registry helpers. Move eligibility
predicates before bounded page filling, and replace unbounded relationship
collection with declared many pages and child continuation. See the diagnostics
and examples in [oxlint.md](./oxlint.md).

The [packed example](https://github.com/ImRLopezAG/cvx-kit/tree/main/test/fixture-packed-querying/convex/) contains complete
schema, relation, engine, contract, Query-registry, auth-adapter, and child-endpoint
wiring. `bun run test:package:querying` exercises strict installed and minimum-peer
consumers, all consumer rules, and multi-entity/filter/order continuation tests.
The local native smoke runner exercises registered Convex validators and cursors;
these checks do not establish hosted production performance.

Run `bunx vp test run test/querying-relations-stress.test.ts --silent=false` to
report per-page p10, p50, and p99 latency for each filter/order/page-size case,
plus an aggregate for duplicate child continuations. Reports include sample
counts and use nearest-rank percentiles. A small sample's p99 is its maximum;
the measurements include `convex-test` and instrumentation overhead. Read
counters and ordered-result assertions remain separate from latency measurements.

### Custom native cursor payloads

Use the configured engine for native pagination that requires its own traversal:

```ts
const codec = querying.cursorCodec(ctx, {
	domain: 'clients-search-v1',
	bind: { filters, sort, departments: serverDerivedDepartments },
	schema: z.strictObject({ native: z.string().nullable(), seen: z.bigint() }),
})
const position = args.cursor ? codec.open(args.cursor) : { native: null, seen: 0n }
// Recheck current permissions and authorize every native row before returning it.
const nextCursor = codec.seal({ native: nativeResult.continueCursor, seen: position.seen + 1n })
```

The facade uses the engine's captured key ring (or its lazy environment configuration),
rotation and central policy version. Managed query registration supplies mode, principal,
organization, tenant and role; registered authority takes precedence over a trusted adapter.
Native contexts require the engine's explicit trusted query adapter. Unmanaged contexts,
mutations and actions are rejected before codec use. No reader is returned.

**A successful `open` proves integrity only. It never authorizes a row or a request.**
Recheck current authorization on every request. Bind server-derived permissions,
departments and other dynamic claims not represented by managed scope explicitly.
Treat client filters and sort as binding data, never as authority.

`seal` and `open` synchronously validate the payload schema. Schema transforms must be
synchronous and produce supported Convex values; both input and output are bounded.
`seal` retains canonical input bytes after validation; `open` returns the parsed output,
so input-to-output transforms run once per operation.
Signed 64-bit bigint, bytes and Convex float values are supported. Accessors, cycles,
unsupported values and excessive depth, node count or size are rejected. Serialized
payloads are limited to 8 KiB; domain and binding data are bounded too. Schema failures
and malformed, tampered or mismatched tokens throw the exported `CursorError` with
`code: 'invalid-cursor'` and the fixed message `Invalid cursor`, without validation details.
Key configuration failures retain the engine's separate configuration error.

AES-SIV is deterministic: equal payloads with equal bindings reveal equality. Public
codec tokens and engine pagination tokens are isolated in both directions. A changed
domain, caller binding, managed scope or central policy version invalidates the token.
Retain old keys during rotation to accept their tokens; removing a key rejects them.
There is no `wrap` helper: seal continuation and split payloads separately, with each
boundary's own counters and traversal state.

## Public failure transport

Direct callers keep native errors. For client-facing endpoints, use the explicit
`queryFailureContract` adapter and the fixed client `queryErrors` declaration.
See [client failures](client-failures.md#transporting-engine-failures) for the
ordinary auth endpoint catch and Effect expected-error channel. Do not identify
invalid cursors by message substrings or forge Convex system errors.
