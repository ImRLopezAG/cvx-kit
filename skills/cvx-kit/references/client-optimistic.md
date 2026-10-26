# Conservative optimistic lists

Import `defineOptimisticList` from `cvx-kit/react`. Its `patch`, `insert` and
`delete` methods are synchronous helpers for Convex's public
`OptimisticLocalStore`. Use them inside native `withOptimisticUpdate` or the
`optimisticUpdate` option of `useCommand`. Convex owns replay, rebase and rollback;
callbacks must be synchronous and repeatable. There is no extra cache or refetch
controller.

Declare the descriptor in a browser-safe module owned by the endpoint, beside
its public DTO and shared filter declaration. Share these semantics with the
server implementation. A descriptor is an explicit attestation by the endpoint
author, not authorization supplied by mutation input or a deduction from client
filters. It never grants server write permission.

```tsx
import { useMutation } from 'convex/react'
import { defineOptimisticList } from 'cvx-kit/react'
import { api } from './_generated/api'

export const tasks = defineOptimisticList(api.tasks.list, {
	id: '_id',
	writable: ['title', 'status'],
	fields: () => ['_id', 'title', 'status', 'rank'],
	session: (args) => args.sessionKey,
	membership: (args) => ({
		predicate: { kind: 'scalar', field: 'status', operator: 'eq', value: args.status },
		complete: true,
	}),
	order: () => [
		{ field: 'rank', direction: 'asc' },
		{ field: '_id', direction: 'asc' },
	],
	interval: (args, result) =>
		args.paginationOpts.cursor === null && result.isDone ? { lower: null, upper: null } : undefined,
})

const rename = useMutation(api.tasks.rename).withOptimisticUpdate((store, args) => {
	tasks.patch(store, args.id, { title: args.title })
})
```

Use the application's actual DTO, endpoint arguments and session key. An
endpoint without a session argument can use `session: () => null` when the
Convex client's authentication lifecycle owns session isolation. This helper
only sees the current client's cache; it does not maintain an auth/session cache.

`fields(args)` names fields permitted by that output projection. `writable`
limits patch keys to public DTO fields, with their actual types; the ID remains
immutable. A patch updates only fields already present on each row and allowed
by both declarations. Even a permitted optional field that is absent stays
absent: a user-provided patch cannot establish whether that absence reflects
redaction. Explicit deletion removes every loaded copy of that ID. Neither
operation mutates query arguments or authoritative result objects.

Every callback enumerates `getAllQueries(reference)`. Loaded pages are grouped
by all non-pagination arguments and the descriptor's session value, including
different page sizes and overlapping interval subscriptions. Each loaded copy
is patched independently using its own projection. Loading queries remain
untouched. The helper writes whole result objects with `setQuery`, preserving
all metadata values and copying no cursors between pages.

Membership uses U7's `evaluateFilter` and `FilterAst`, including the same scalar,
logical and variant semantics. Only permitted fields present on the original
row are accessible. A known predicate evaluating to false removes the row;
unknown keeps its safe patched fields. A relation predicate, protected field,
or missing value remains unknown. Declare `complete: false` whenever hidden
server eligibility or custom endpoint logic is not fully represented. A true
known predicate plus incomplete semantics cannot justify an insertion or move.
Known necessary predicates can still prove nonmembership when false.

Insertion and a sort-changing patch need all of the following:

- A complete membership attestation evaluating to true.
- The endpoint's complete total order, including its tie breakers, using visible
  values. A neighbor with an absent/protected order key prevents rank inference.
- Exactly one attested loaded interval containing the new key.

Interval bounds are tuples in the declared order: lower exclusive and upper
inclusive. `null` attests an unbounded side. Tuple lengths match the order fields;
comparisons use native Convex value ordering, with each field's direction.
The complete first-page example above can attest the entire list. For partial
pages, provide independently known public interval bounds from the server's
list contract; `continueCursor`, `endCursor`, `splitCursor`, `isDone` on a later
page, and a guess at the last visible row are not such bounds. Never decode
protected cursors. Omit `interval` when the endpoint does not expose enough
information.

An insert selects only fields permitted by the destination projection. It does
not merge different rows' field knowledge. An existing ID is not inserted again;
use `patch` to edit it. Placement deduplicates IDs within loaded pages and moves
the edited ID to one destination. Overlapping parent/split intervals that both
claim the destination are ambiguous, so insertion/movement waits for the
server's refresh. An interval whose membership or ordering is unknown also
prevents treating another interval as the unique destination. Existing copies
retain their own field knowledge during movement; a richer copy cannot supply
fields absent from a destination copy. Existing copies still receive safe patches. A destination
outside loaded intervals also leaves placement unchanged. A sort key absent
before a patch cannot become ordering knowledge from that patch alone.

These are deliberate unknown cases, not a client replacement for authorization,
server predicates or pagination. No cursor is fabricated and no unsupported
automatic refetch is started. Server modules remain usable without React;
import only this optional facade in React consumers.
