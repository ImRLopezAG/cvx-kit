# Reactive paginated lists

Import `usePaginatedList` from `cvx-kit/react`. React is an optional peer; backend and pure error imports do not require it.

```tsx
const list = usePaginatedList(
	api.tasks.paginatedList,
	{ filters, order: 'desc' },
	{
		pageSize: 50,
		onFailure: 'state', // default; 'throw' sends the original error to the nearest React boundary
		onInvalidCursor: 'restart', // default; 'throw' sends validated invalid cursors to the error boundary
		resetIdentity: { user: userId, scopeVersion },
	},
)
```

The public query must accept `paginationOpts: PaginationOptions` and return the engine page DTO, including optional `completeness`. Map `{ paginationOpts, ...args }` to `engine(ctx).tasks.paginate({ ...args, ...paginationOpts })` on the server. With Effect auth constructors configure `query: { errors: queryFailureContract }` and use `Effect.tryPromise({ try: () => engine(ctx).tasks.paginate(...), catch: error => error })`. Engine failures are not automatically transport failures. Ordinary native errors keep their existing behavior.

`rows` and `completeness` infer from the function reference. `isLoading` means the first interval is loading. `isFetchingNextPage` covers a pending next interval or replacement split. `hasNextPage` means a next interval can currently load; `fetchNextPage()` is a no-op while loading, splitting, failed, skipped or exhausted. Page size must be an integer from 1 to 100 (the engine hard ceiling); respect any lower server-configured ceiling. Empty advancing budget pages stay explicitly loadable; the hook never loops automatically.

Pass `'skip'` for args to remove all subscriptions and clear rows. Query name, effective args, page size and `resetIdentity` determine the reset identity. Object key order is insignificant at every depth; array order matters. The opaque `resetKey` is stable for equivalent inputs and changes on identity changes or invalid-cursor restart. Pagination transport is supplied by the hook; it is not a caller argument. Never use credentials as reset identities.

Use `resetIdentity` to clear immediately on sign-out or scope change. Server revocation is observable only when a subscription reruns; until then the client cannot infer it. Any observed error clears all cached rows, cursors, subscriptions and completeness. `failure` exposes a validated failure, defaulting to the fixed `queryErrors` contract. Pass `errors` for an explicit endpoint error contract; references have no automatic error metadata. Unknown, malformed and unrelated errors become `UnknownFailure`, without matching message text. `error` exposes the original `Error` alongside that decoded failure for caller-controlled boundaries or logging; neither the error nor its envelope is mutated.

Only a `ConvexError.data` envelope validated by both the selected contract and fixed `queryErrors` can trigger invalid-cursor recovery. Restart clears the old epoch and subscribes to page one once, before applying `onFailure`. Successful pages do not replenish this recovery allowance; a repeated invalid cursor obeys `onFailure`. A query/args/auth/reset identity change starts a new episode. `onInvalidCursor: 'throw'` throws the original transported error even with `onFailure: 'state'`.

With `onFailure: 'throw'`, every unrecovered failure throws the original subscription `Error` or `ConvexError`, preserving its identity and `data` for the nearest React error boundary. A domain code unknown to the default decoder still reaches the boundary unchanged. The hook does not return a list from a throwing render; use state mode to inspect `failure` and `error` yourself. When the boundary commits its fallback, the failed list unmounts and Convex releases all its subscriptions, including previously loaded pages. Remount the list when retrying (for example, reset a keyed boundary) to start a fresh epoch with no cached rows or cursors and a new invalid-cursor recovery allowance.

Ordered intervals honor native `endCursor` boundaries. Required and recommended splits retain their parent until both children arrive, then replace it atomically. Completeness comes from the latest committed interval, including while children load. Rows preserve repeated relation-edge occurrences; no ID deduplication occurs. Every loaded interval stays subscribed for reactive updates and Convex-owned optimistic rollback. Reset epochs prevent late results and old fetch callbacks from reviving earlier lists; unmount uses the public subscription cleanup.

Root native search is supported. Return the root `paginationMode: 'native-search'`
marker through the registered page validator. The first page fixes browse or search
mode for that epoch; mixed modes or required search splits fail closed and clear
cached rows. A search endpoint maps `paginationOpts` to
`engine(ctx).tasks.search('search_text', text).paginate({ ...paginationOpts, scanLimit })`.
Select filters, groups and `.with(...)` before pagination as on the server.

Search appends one successor without pinning a predecessor `endCursor` or creating
split children. Already-loaded child input tokens stay immutable when parent
windows rerun. Native SDK journals are opaque and own reactive boundaries; never
decode, manufacture or replace them. The hook performs no ID deduplication or refill.
An earlier capped window retains loaded descendants; a capped tail stops new loads.
`numItems`/`pageSize` is an initial target, so a live search window may exceed it.
Short and denied-empty continuing windows require an explicit user action:

```tsx
<button disabled={!list.hasNextPage || list.isFetchingNextPage}
 onClick={() => list.fetchNextPage()}>Load more</button>
```

Changing text, filters, cap, page size, query or `resetIdentity` starts a fresh epoch;
use reset identity on principal/role/scope changes. Existing skip, failure, invalid
cursor recovery and late-frame protections apply equally to search.

Suspense and optimistic membership helpers are outside this API.
