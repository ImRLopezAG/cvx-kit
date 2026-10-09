# Commands — declare handlers once, execute through Effect

Use `createEffectFoundation` from `cvx-kit/effect` for application commands.
The Foundation binds observability, permissions, and audit writing once. Each
registry injects its domain context and declares schemas, handler, and hooks
inside `command({...})`. `exec(operation, input, host)` returns a lazy Effect;
execution does not accept a replacement handler.

Install the Effect peer before importing this facade:

```sh
bun add effect@'>=4.0.1 <5'
```

The old `Foundation.Command` constructor and `exec({ operation, handler })`
API are **deprecated**, retained for compatibility with existing consumers.
Their [compatibility reference](./commands-legacy.md) is for migration and
maintenance. The Foundation component, Query kernel, observability, and
transaction result helpers remain available. No component mount is required
by `createEffectFoundation` itself.

## Declare commands

This complete example uses an ordinary async handler. It still executes through
the Effect lifecycle, with input-first, context-second handler arguments.
`context` resolves per invocation; shared registries must not capture an
authenticated request context.

<!-- packed-effect-example -->

```ts
import { type AuditEntryInput } from 'cvx-kit/components/foundation'
import { createEffectFoundation } from 'cvx-kit/effect'
import { z } from 'zod'

type Host = {
	actorId: string
	rename: (id: string, title: string) => Promise<void>
	appendAudit: (entry: AuditEntryInput) => Promise<void>
}
const input = z.object({ id: z.string(), title: z.string() }).strict()
const result = z.object({ ok: z.literal(true) }).strict()
const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'RENAME_FAILED' }),
	},
	writeAudit: (host: Host, entry) => host.appendAudit(entry),
})
export const commands = foundation.Command({
	context: (host: Host) => host,
	operations: ({ command }) => ({
		'documents.rename': command({
			input,
			result,
			classification: 'business',
			aggregates: ['document'],
			handler: async (input, context) => {
				await context.rename(input.id, input.title)
				return { ok: true as const }
			},
			audit: ({ command }, context) => ({
				operation: 'documents.rename',
				actorId: context.actorId,
				aggregate: { type: 'document', id: command.id },
			}),
		}),
	}),
})

export const executeRename = (value: z.input<typeof input>, host: Host) =>
	commands.exec('documents.rename', value, host)
```

`classification` and `audit` are mandatory. Input decoding precedes the handler;
final result decoding follows middleware. Handlers return the result schema's
input; audit and completion receive its validated output. Ordinary values,
Promises, `Effect.gen`, and `Effect.fn` all work inside the declaration. Throws
and rejected Promises become defects; use `Effect.fail` or `Effect.tryPromise`
for expected failures in the inferred error channel.

## Execute at the API boundary

Wrap the application's trusted `authMutation` once with `effectZodApiBuilder`
in `convex/functions.ts`, then return the command Effect from the endpoint:

This wiring sketch assumes imported `Context`, `effectZodApiBuilder`, the
configured `authMutation`, and the domain's `commands` and schemas.
`toHost(ctx)` is the application's mapping from authenticated mutation context
to the example's `Host` capabilities.

```ts
// convex/functions.ts — after creating authMutation through createAuthFunctions
const effectAuthMutation = effectZodApiBuilder(authMutation, {
	services: () => Context.empty(),
})

// convex/api/documents.ts — imports schemas, commands, and the shared builder
export const rename = effectAuthMutation({
	args: renameInput,
	returns: renameResult,
	handler: (ctx, input) => commands.exec('documents.rename', input, toHost(ctx)),
})
```

The host passed to `exec` must match the registry's `context` resolver. For the
complete example above, build its `Host` from the authenticated mutation's
`ctx.actor` and wrapped `ctx.db`; do not accept actor or tenant identity from
client arguments. For service-based domains, provision services from the
trusted context in the shared builder. Use `effectApiBuilder` for native Convex
builders and `effectZodApiBuilder` for Zod custom builders such as the kit's
auth constructors. See [the complete domain-to-API example](./effect.md) and
[authenticated builder wiring](./auth.md).

The builder runs the Effect in an invocation scope and awaits finalizers.
Nested commands and queries compose into the same Effect; do not start an
inner `Effect.runPromise`. Native Convex references retain argument/result
types, but do not transport Effect's server-side error and service channels.

## Lifecycle and hooks

1. Decode `input`, start observation, then resolve invocation-local context.
2. Check a declared `permission` through the Foundation's injected
   `checkPermission(host, { permission, operation })`. A missing checker fails
   closed. The policy receives the original host.
3. Run `prepare(context, input)` if configured. Replay validates the stored
   result and skips middleware, guards, handler, audit writing, and completion.
4. Run the operation's `middleware`, wrapping `defaults.guard(context)`, the
   operation's `guard(context, input)`, and `handler(input, context)`.
5. Decode the middleware chain's final result, derive `audit({ command, result },
   context)`, enforce `aggregates`, and call the injected `writeAudit(host, entry)`
   when the audit is non-null.
6. Await the completion closure from `prepare`, then finish observation.

Effect middleware is a callback returning a value, Promise, or Effect, rather
than the legacy facade's middleware arrays. `next()` returns an Effect;
`next({ context })` merges a context extension for downstream guards and the
handler. Prepare and audit receive the original domain context. Short circuits
still validate and audit; calling `next()` twice fails. Defaults support a
registry guard; declare middleware per operation.

Guards should be read-only. Put authorization required on replay in the
permission policy or prepare lookup, because replay skips both guards. When
`result` transforms its input, store the validated output in completion and
supply a `replayResult` output validator to avoid applying the transform twice.
Use `effectTransactionalIdempotency` for receipt-backed replay;
[domain integrations](./domain-operations.md) cover idempotency, workflows,
CRUD, and selected operation tools.

Commands that write run inside Convex mutations. Let failures escape the
mutation so Convex rolls back business, audit, and completion writes. Returning
a failure value after a write can commit that write. Observation completion is
command completion, not proof that the enclosing transaction committed.

## Migrate the deprecated API

- Replace the command facade from `new Foundation(...)` with
  `createEffectFoundation(...)`. Move `writeAudit` out of the legacy
  `observability` options into the Effect Foundation's top-level options.
- Replace `new Command(operations, defaults)` with
  `foundation.Command({ context, operations: ({ command }) => ({ ... }), defaults })`.
- Use `input` instead of the old schema property `command`. Move each handler
  from executor options into its operation's `command({...})` declaration.
- Change handlers from `(context, input)` to `(input, context)`. Hooks retain
  their documented context-first or resolution-first signatures.
- Replace Promise executor factories with `exec(operation, input, host)` and
  return the resulting Effect through a shared API builder. Keep authentication,
  tenant policy, triggers, and native validators on that builder.

Existing consumers can migrate one domain at a time. Only the Effect API is
recommended for new command code; the deprecated facade remains callable until
a separately announced breaking release. See the [old API reference](./commands-legacy.md)
when maintaining a domain that has not migrated yet.
