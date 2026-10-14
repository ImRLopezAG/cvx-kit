# Relations over a native-ID union

Available from cvx-kit 0.1.18. Use `forTable` to select one declared, registered
native-ID member for a direct relation. The stored field and generated root DTO
retain the original union. Selection adds relation metadata, without adding a
discriminator, shadow foreign key, or junction table.

## Boundaries and native indexes

Declare the link on the ordinary source boundary:

```ts
// convex/domain/tasks/schema.ts
import { z } from 'zod'
import { zodTable } from 'cvx-kit/zod-table'

export const tasks = zodTable(
	'tasks',
	(id) => ({
		status: z.enum(['open', 'closed']),
		rel: z
			.union([
				id('tasks'),
				id('leads'),
				id('contacts'),
				id('clients'),
				id('creditors'),
				id('deals'),
				id('payments'),
				id('ledger'),
			])
			.optional(),
	}),
	{
		commandFields: ['status', 'rel'],
		publicFields: ['status', 'rel'],
	},
)
tasks.table.index('by_rel', ['rel'])
```

Include the generated native table for each registered boundary in your actual
`defineSchema`. Define supporting indexes before compiling relations. The
inverse query needs `tasks.by_rel`; the linked target does not need a second
copy of the link. Keep payments and ledger as actual generated variant-table
boundaries, as shown in [variant querying](./variant-querying.md).

## Declare each direction

```ts
// convex/relations.ts
import { defineRelations } from 'cvx-kit/relations'
import {
	tasks,
	leads,
	contacts,
	clients,
	creditors,
	deals,
	payments,
	ledger,
} from './domain/tables'

export const relations = defineRelations(
	{
		tasks,
		leads,
		contacts,
		clients,
		creditors,
		deals,
		payments,
		ledger,
	},
	(r) => ({
		tasks: {
			referenceTask: r.one.tasks({ from: r.tasks.rel.forTable('tasks'), to: r.tasks._id }),
			referencingTasks: r.many.tasks({ from: r.tasks._id, to: r.tasks.rel.forTable('tasks') }),
			lead: r.one.leads({ from: r.tasks.rel.forTable('leads'), to: r.leads._id }),
			contact: r.one.contacts({ from: r.tasks.rel.forTable('contacts'), to: r.contacts._id }),
			client: r.one.clients({ from: r.tasks.rel.forTable('clients'), to: r.clients._id }),
			creditor: r.one.creditors({ from: r.tasks.rel.forTable('creditors'), to: r.creditors._id }),
			deal: r.one.deals({ from: r.tasks.rel.forTable('deals'), to: r.deals._id }),
			payment: r.one.payments({ from: r.tasks.rel.forTable('payments'), to: r.payments._id }),
			ledgerEntry: r.one.ledger({ from: r.tasks.rel.forTable('ledger'), to: r.ledger._id }),
		},
		leads: { tasks: r.many.tasks({ from: r.leads._id, to: r.tasks.rel.forTable('leads') }) },
		contacts: {
			tasks: r.many.tasks({ from: r.contacts._id, to: r.tasks.rel.forTable('contacts') }),
		},
		clients: { tasks: r.many.tasks({ from: r.clients._id, to: r.tasks.rel.forTable('clients') }) },
		creditors: {
			tasks: r.many.tasks({ from: r.creditors._id, to: r.tasks.rel.forTable('creditors') }),
		},
		deals: { tasks: r.many.tasks({ from: r.deals._id, to: r.tasks.rel.forTable('deals') }) },
		payments: {
			tasks: r.many.tasks({ from: r.payments._id, to: r.tasks.rel.forTable('payments') }),
		},
		ledger: { tasks: r.many.tasks({ from: r.ledger._id, to: r.tasks.rel.forTable('ledger') }) },
	}),
)
```

`forTable` accepts a single ID, duplicate ID members, and optional/nullable ID
unions. Every non-null member must be a native ID; mixed string/number/object
domains and null-only fields cannot be narrowed. The selected member must be
declared and registered. A declared but unregistered member cannot be selected;
other registered members remain usable. Repeated selection permits the same
member only. Unrelated scalar joins still require exact compatible domains.

References and member metadata are immutable and owned by the registry. Do not
copy references or pass them from a different registry. Runtime ownership checks
also reject structurally identical foreign references.

Ordinary source unions may target a variant table's shared `_id`, preserving its
generated DTO union. Existing `branch('payments', tag)._id` target guards also
compose with a narrowed ordinary field. In 0.1.18, narrowing a branch-scoped
field or combining a narrowed reference with `.through(...)` is unsupported and
rejected at declaration. Existing branch and junction declarations continue to
work without member narrowing.

## Use generated contracts through the authenticated engine

```ts
// convex/querying.ts
import { createQueryEngine } from 'cvx-kit/querying'
import schema from './schema'
import { relations } from './relations'
export const querying = createQueryEngine({ schema, relations })
```

```ts
// convex/domain/tasks/contracts.ts
import { relations } from '../../relations'
import { tasks } from './schema'
export const taskInput = relations.tables.tasks.paginationOpts({
	status: true,
	referenceTask: { status: true },
	referencingTasks: { status: true },
})
export const taskPage = relations.tables.tasks.pageDto({
	referenceTask: true,
	referencingTasks: true,
	payment: true,
	ledgerEntry: true,
})
export const referencingInput = relations.tables.tasks
	.paginationOpts({ status: true })
	.extend({ parentId: tasks.schema.shape._id })
export const referencingPage = relations.tables.tasks.pageDto({})
```

```ts
// convex/api/tasks.ts
import { authQuery } from '../functions'
import { querying } from '../querying'
import { taskInput, taskPage, referencingInput, referencingPage } from '../domain/tasks/contracts'

export const list = authQuery({
	args: taskInput,
	returns: taskPage,
	handler: (ctx, args) =>
		querying(ctx)
			.tasks.with({
				referenceTask: true,
				referencingTasks: true,
				payment: true,
				ledgerEntry: true,
			})
			.paginate(args),
})
export const referencing = authQuery({
	args: referencingInput,
	returns: referencingPage,
	handler: (ctx, { parentId, ...options }) =>
		querying(ctx).tasks.relation(parentId, 'referencingTasks').paginate(options),
})
```

Use your configured [authenticated facade](./auth.md) with current membership,
effective domain read policies, and server cursor keys from [querying](./querying.md).
If your app uses domain Query registries, put these handlers behind the same
generated contracts using [domain contracts](./domain-contracts.md).

A wrong union member, absent/null link, missing target, or unreadable target
produces `null` for a one relation. Many relations return bounded pages. The
engine normalizes against the selected table before fetching, and inverse pages
use equality on the actual parent ID through `by_rel`. It does not fetch every
possible table. Source, target, and ancestor policies still apply, including
dependent client or finance access declared by the application. Page filling
and predicates use authorized matches: exhaustion proves `none`; reaching a
budget limit throws instead. Raw private fields stay outside generated DTOs.

Resume a nested `referencingTasks` page through `referencing` using its cursor,
parent ID, filters, and order. Deep paths use the ancestor navigation described
in [querying](./querying.md). Member metadata participates in registry identity
and cursor binding alongside actor/scope, parent/path, filters, order, indexes,
and output selection. Resume reauthorizes current ancestry; relink, deletion,
and revocation cannot preserve old authority. A declaration change invalidates
old cursors; restart pagination. Changing page size alone is supported.

## Authorize link writes independently

Reading a task or target does not authorize linking them. In one public mutation,
parse the generated command input, resolve current membership, authorize the
source task, normalize and fetch the intended target, and apply its domain's
link policy. Validate the complete new storage row and write the task and audit
in the same transaction. Let failures escape so all writes roll back. Missing,
denied, and readable-but-link-forbidden targets must preserve the prior task,
old inverse membership, and audit history.

Distinguish omitted `rel` (keep the current link) from an explicit clear operation.
For the optional-only schema above, clearing removes `rel`; it does not store
`null`. If an API accepts a separate clear flag or nullable command wrapper,
translate it before validating the complete storage row. Recheck authority at
mutation execution, including membership revocation since the caller's last read.

The [executable native application fixture](https://github.com/ImRLopezAG/cvx-kit/tree/main/test/fixture-packed-variant-querying)
contains generated schemas, registry wiring, authenticated endpoints, policies,
atomic commands, and runtime verification against installed public exports.
Run `bun run test:package:variant-querying` for candidate acceptance, or
`node scripts/test-packed-variant-querying.mjs --package cvx-kit@0.1.18` for an
exact published consumer. Native Convex codegen, transactions, subscriptions,
and current/minimum peer acceptance complement focused tests for index plans,
read budgets, normalization, and cursor replay; they do not establish hosted
application deployment acceptance.

## Migrate existing links safely

1. Deploy an additive schema accepting old links and the new native-ID field;
   add its index, generate types, and update callers without removing old data.
2. Choose a write barrier or transitional writers that atomically maintain the
   old and new representations. Protect relinks and clears while backfill runs;
   a stale backfill must not restore a link that a newer mutation cleared.
3. Backfill with bounded, resumable pages and checkpoints. Make each row update
   idempotent and conditional on the expected old state. Detect conflicting old
   links and record dangling IDs for review. Normalize a known candidate against
   its expected table; never infer native IDs from opaque legacy strings.
4. Verify counts, per-table membership, inverse-page parity, missing/denied
   behavior, and audited write parity. Resolve conflicts and opaque strings
   through an explicit preservation, archival, or removal decision.
5. Switch reads and commands, regenerate callers, and restart cursors whose
   registry identity changed. Retain the old representation and compatible
   transitional writer for a rollback window; test rolling back after new writes.
6. Remove old validators, indexes, fields, and transitional writes only after
   parity and rollback acceptance, through the application's authorized rollout.

Installing this package performs no host-data migration or deletion. Keep the
application's migration checkpoint, rejected-row report, and rollback evidence
with its own deployment records.
