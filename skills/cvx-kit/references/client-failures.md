# Client failures and mutation commands

Use an explicit error contract. Generated Convex function references do not carry
error declarations. `cvx-kit/errors` exports pure `decodeFailure`, `matchFailure`
and `queryErrors`; it does not import React. Install a supported React 18 or 19
peer only when importing `cvx-kit/react`.

```ts
import { decodeFailure, matchFailure } from 'cvx-kit/errors'

const failure = decodeFailure(caught, taskErrors)
matchFailure(caught, taskErrors, {
	FORBIDDEN: () => showForbidden(),
	CONFLICT: ({ details }) => showRevision(details.revision),
	_: () => showUnexpected(),
})
```

`decodeFailure` extracts `ConvexError.data` and delegates to the declaration's
`decode`. Other errors, malformed data and throwing accessors yield only
`{ _tag: 'UnknownFailure', version: 1 }`. It never parses messages or retains causes.
A declared failure has `_tag: 'DeclaredFailure'` and its separate `code`; narrow
both before accessing code-specific details. Handlers dispatch on `code`.
Every declared code requires a handler unless `_` is provided. Without `_`, an
unknown error returns `UnknownFailure`. With `_`, unknown and unhandled declared
failures go to that callback. Callback exceptions propagate to the caller.
If `_` is itself a declared code, its handler also serves as the fallback and
must narrow the full failure union before accessing declared details.

A query consumer can call `decodeFailure(queryError, taskErrors)` directly; no
stateful `useFailure` wrapper is necessary.

```ts
import { useCommand } from 'cvx-kit/react'

const save = useCommand(api.tasks.update, {
	errors: taskErrors,
	optimisticUpdate: (store, args) => {
		// Synchronous Convex cache update, using the inferred mutation args.
	},
})
const result = await save(args)
if (result.ok) showSaved(result.value)
else if (result.failure._tag === 'DeclaredFailure') {
	if (result.failure.code === 'CONFLICT') showRevision(result.failure.details.revision)
}
```

The callable preserves Convex's optional/required mutation args and return type.
It resolves `{ ok: true, value }` or `{ ok: false, failure }` for success, declared
failure and unknown failure. `save.isPending` covers all concurrent calls;
`save.result` belongs to the latest invocation and is undefined before it settles.
An older concurrent completion cannot overwrite a newer invocation's result.
The previous settled result remains visible while the latest invocation is pending.
The callable identity changes with its state, so memoized consumers receive updates.

`optimisticUpdate` is attached once through Convex's `withOptimisticUpdate` for
each mutation/callback identity. Keep the callback identity stable when practical.
The hook never invokes it manually. Convex may replay/rebase it as subscribed data
changes while a mutation is pending, then removes it on success or failure.
React Strict Mode may evaluate render memoization more than once; this does not
execute the optimistic callback. Async optimistic callbacks are rejected by types.

## Transporting engine failures

Direct engine calls still throw their existing native errors. Use the explicit
server adapter `queryFailureContract` from `cvx-kit/querying` when an endpoint needs
fixed public failures for `invalid-cursor`, `FIELD_GROUP_DENIED` and `QUERY_FANOUT`.
Their details are empty. Key-configuration errors, unrelated errors and objects
that merely claim those codes remain unknown; messages never confer identity.
The client decodes using `queryErrors` from `cvx-kit/errors` (or `cvx-kit/react`).

Effect middleware distinguishes expected failures from defects. Supply the
adapter as its query error policy and use `Effect.tryPromise` to place native
query errors in the expected-error channel:

```ts
import { Effect } from 'effect'
import { createEffectAuthFunctions } from 'cvx-kit/effect'
import { queryFailureContract } from 'cvx-kit/querying'

const functions = createEffectAuthFunctions(authConfig, {
	query: { errors: queryFailureContract },
	mutation: {},
	action: {},
	systemQuery: {},
	systemMutation: {},
	systemAction: {},
})
export const list = functions.authQuery({
	args: relations.tables.tasks.paginationOpts({ title: true }),
	handler: (ctx, args) =>
		Effect.tryPromise({
			try: () => querying(ctx).tasks.paginate(args),
			catch: (error) => error,
		}),
})
```

Without that explicit expected-error channel, ordinary throws/rejections are
defects and remain `UnknownFailure`. Composite failures, cleanup defects and
interrupts also remain unknown. Do not change the middleware's general policy.

For ordinary `createAuthFunctions().authQuery`, project at the endpoint boundary:

```ts
try {
	return await querying(ctx).tasks.paginate(args)
} catch (error) {
	throw new ConvexError(queryFailureContract.project(error))
}
```

Use this catch inside the endpoint handler, after authentication. An unrelated
Effect `errors` policy will intentionally normalize an already-transported
`ConvexError`; use the adapter policy above instead of nesting error transports.
This adapter does not manufacture Convex system pagination errors.
