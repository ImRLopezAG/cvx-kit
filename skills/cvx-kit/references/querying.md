# `cvx-kit/querying` — typed, authorized stream pagination

Declare relationships with `cvx-kit/relations`, configure one query engine, then
paginate with a small declarative chain. The engine runs streams and relationship
lookups in the caller's Convex query transaction. Filtering determines eligible
parents before they fill a page. `include` and native `paginated(dto)` remain
independent APIs.

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
references and junctions are supported. Tables must be object-shaped `zodTable`
or `tenantTable` boundaries; variant tables are outside this API. Declarations
are validated against table ownership, field compatibility, and supporting
indexes. Convex does not infer relationships; this registry supplies them.

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

Without an explicit choice, the planner selects the longest usable equality
prefix, with stable index-name ordering for ties and creation-time fallback.
OR branches contribute only guaranteed common bindings. `order: 'desc'` reverses
the selected native index order; it does not sort by an arbitrary field.

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

Page sizes are positive integers up to 100. Shared request budgets cover read
operations, index ranges, raw candidates, document bytes, fan-out, traversal
depth, and memo entries, including managed policy reads. Native request read
limits may lower ceilings. Output relationship depth is at most four.

If eligibility cannot be established within the budget, execution throws
`MANAGED_READ_BUDGET`; it does not return a misleading exhausted page or conclude
that a negative relationship predicate matched. Policy errors propagate rather
than turning into eligible rows. Memoization is request-local and preserves
junction multiplicity. Relationships can require many database reads; one public
query does not imply one physical read. Document accounting is an application
bound, not a measurement of Convex storage/index/prefetch I/O.

Arbitrary async predicates, custom projections/sorts, mutation/action execution,
search/vector optimization, and global caching are outside this API. Index
selection reduces candidates where possible; filtering every supported scalar
field does not guarantee an efficient index for every filter combination.

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
