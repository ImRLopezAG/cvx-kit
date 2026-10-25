# Reactive paginated lists

Import `usePaginatedList` from `cvx-kit/react`. React is an optional peer; backend and pure error imports do not require it.

```tsx
const list = usePaginatedList(
	api.tasks.paginatedList,
	{ filters, order: 'desc' },
	{
		pageSize: 50,
		onInvalidCursor: 'restart', // default; 'throw' sends validated invalid cursors to the error boundary
		resetIdentity: { user: userId, scopeVersion },
	},
)
```

The public query must accept `paginationOpts: PaginationOptions` and return the engine page DTO, including optional `completeness`. Map `{ paginationOpts, ...args }` to `engine(ctx).tasks.paginate({ ...args, ...paginationOpts })` on the server. With Effect auth constructors configure `query: { errors: queryFailureContract }` and use `Effect.tryPromise({ try: () => engine(ctx).tasks.paginate(...), catch: error => error })`. Engine failures are not automatically transport failures. Ordinary native errors keep their existing behavior.

`rows` and `completeness` infer from the function reference. `isLoading` means the first interval is loading. `isFetchingNextPage` covers a pending next interval or replacement split. `hasNextPage` means a next interval can currently load; `fetchNextPage()` is a no-op while loading, splitting, failed, skipped or exhausted. Page size must be an integer from 1 to 100 (the engine hard ceiling); respect any lower server-configured ceiling. Empty advancing budget pages stay explicitly loadable; the hook never loops automatically.

Pass `'skip'` for args to remove all subscriptions and clear rows. Query name, effective args, page size and `resetIdentity` determine the reset identity. Object key order is insignificant at every depth; array order matters. The opaque `resetKey` is stable for equivalent inputs and changes on identity changes or invalid-cursor restart. Pagination transport is supplied by the hook; it is not a caller argument. Never use credentials as reset identities.

Use `resetIdentity` to clear immediately on sign-out or scope change. Server revocation is observable only when a subscription reruns; until then the client cannot infer it. Any observed error clears all cached rows, cursors, subscriptions and completeness. `failure` exposes a validated failure, defaulting to the fixed `queryErrors` contract. Pass `errors` for an explicit endpoint error contract; references have no automatic error metadata. Unknown, malformed and unrelated errors become `UnknownFailure`, without matching message text.

Only a `ConvexError.data` envelope validated by both the selected contract and fixed `queryErrors` can trigger invalid-cursor recovery. Restart clears the old epoch and subscribes to page one once. Successful pages do not replenish this recovery allowance; a repeated invalid cursor becomes visible failure. A query/args/auth/reset identity change starts a new episode. `onInvalidCursor: 'throw'` throws the original transported error to the nearest React error boundary. Other failures remain in `failure`.

Ordered intervals honor native `endCursor` boundaries. Required and recommended splits retain their parent until both children arrive, then replace it atomically. Completeness comes from the latest committed interval, including while children load. Rows preserve repeated relation-edge occurrences; no ID deduplication occurs. Every loaded interval stays subscribed for reactive updates and Convex-owned optimistic rollback. Reset epochs prevent late results and old fetch callbacks from reviving earlier lists; unmount uses the public subscription cleanup.

Suspense, optimistic membership helpers and native search pagination are outside this API.
