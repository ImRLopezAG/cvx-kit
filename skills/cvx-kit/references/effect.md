# Effect domain commands and queries

`cvx-kit/effect` adds cohesive command/query declarations and a shared API
runner. Handlers can return ordinary values, Promises, or Effects. Each
registry returns a lazy Effect from `exec(operation, input, host)`; the API
adapter provides request services and runs it once.

Operation callbacks and registry validation are also deferred until that first
execution runs, and the result or configuration failure is cached. `withContext()`
alone does not build a registry. Calling `expose()` builds it so the selected
operation can be bound. To catch configuration errors in a test without running
handlers, import `checkArchitecture` from `cvx-kit/oxlint` and call
`checkArchitecture({ registries: [queries, commands] })` with your declared registries.

This still performs the normal architecture scan and throws if a supplied registry
has invalid configuration. Import `cvx-kit/oxlint` in tooling and tests only.

This is the recommended command API. The older `Foundation.Command` facade
and `exec({ operation, handler })` executor API are deprecated and retained for
compatibility. Declare handlers inside `command({...})` for new command code.

Install Effect explicitly:

```sh
bun add effect@4.0.1
```

The optional peer range is `>=4.0.1 <5`. Existing imports and Promise-based
Foundation consumers work without Effect installed. Use the public facade;
the internal module paths are not supported imports.

## A complete domain-to-API example

These four TypeScript sections form one module and are compiled together
against the packed public package. The example uses Convex's generic builders
with a concrete schema so it is standalone. In an app, put the schema in
`convex/schema.ts`, import your generated `query`, `mutation`, `QueryCtx`, and
`MutationCtx` from `./_generated/server`, and split the remaining code into
services, domain registries, shared API setup, and endpoint modules.

The API obtains the actor from authenticated Convex identity. Caller arguments
contain only a document key and title. Both services constrain document reads
and writes by that actor; the application should also enforce its own roles
and tenant policies. The small permission checker below only requires a
nonempty trusted actor.

### Contracts and injectable capabilities

The reader has no write methods. The mutation provider will add the writer;
a native query cannot satisfy a command's writer requirement. Expected errors
are values in the Effect error channel, rather than thrown exceptions.

```ts
import { Context, Effect } from 'effect'
import {
	defineSchema,
	defineTable,
	queryGeneric,
	mutationGeneric,
	type DataModelFromSchemaDefinition,
	type QueryBuilder,
	type MutationBuilder,
	type GenericQueryCtx,
	type GenericMutationCtx,
} from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { k } from 'cvx-kit/k'
import { createEffectFoundation, effectApiBuilder } from 'cvx-kit/effect'
import type { AuditEntryInput } from 'cvx-kit/components/foundation'

export const schema = defineSchema({
	documents: defineTable({ key: v.string(), owner: v.string(), title: v.string() }).index(
		'by_owner_key',
		['owner', 'key'],
	),
	audits: defineTable({ actor: v.string(), operation: v.string(), documentKey: v.string() }),
})
type DataModel = DataModelFromSchemaDefinition<typeof schema>
type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>
const nativeQuery: QueryBuilder<DataModel, 'public'> = queryGeneric
const nativeMutation: MutationBuilder<DataModel, 'public'> = mutationGeneric

type Host = { actor: string }
class DocumentMissing {
	readonly _tag = 'DocumentMissing'
}
class RenameRejected {
	readonly _tag = 'RenameRejected'
}
class AccessDenied {
	readonly _tag = 'AccessDenied'
}
class DocumentReader extends Context.Service<
	DocumentReader,
	{ title: (key: string, actor: string) => Effect.Effect<string, DocumentMissing> }
>()('DocumentReader') {}
class DocumentWriter extends Context.Service<
	DocumentWriter,
	{
		rename: (key: string, title: string, actor: string) => Effect.Effect<void, DocumentMissing>
		audit: (actor: string, entry: AuditEntryInput) => Effect.Effect<void>
	}
>()('DocumentWriter') {}
```

### Cohesive domain declarations

`label` is an ordinary async handler, and `preview` uses a generator. `title` uses `Effect.fn` with explicit input
and host annotations. `rename` returns an `Effect.gen` program, yields the
query directly, then uses the injected writer. Its pipe converts the query's
missing-document error into a domain-specific rename rejection before adding
a span. The audit entry sits beside the command, and the shared audit policy
uses the same invocation's writer.

```ts
const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed' as const, errorCode: 'DOCUMENT_OPERATION_FAILED' }),
	},
	checkPermission: (host: Host) =>
		host.actor.length > 0 ? Effect.void : Effect.fail(new AccessDenied()),
	writeAudit: (host: Host, entry: AuditEntryInput) =>
		Effect.gen(function* () {
			const writer = yield* DocumentWriter
			yield* writer.audit(host.actor, entry)
		}),
})
const keyInput = k.object({ key: k.string().min(1) })
const renameInput = keyInput.extend({ title: k.string().trim().min(1) })
const titleResult = k.string().transform((title) => ({ title }))

export const documents = foundation.Query({
	context: (host: Host) => host,
	operations: ({ query }) => ({
		label: query({
			input: keyInput,
			result: k.string(),
			handler: async (input) => `Document ${input.key}`,
		}),
		preview: query({
			input: keyInput,
			result: titleResult,
			permission: 'documents:read',
			handler: (input, host) =>
				Effect.gen(function* () {
					const reader = yield* DocumentReader
					return yield* reader.title(input.key, host.actor)
				}),
		}),
		title: query({
			input: keyInput,
			result: titleResult,
			permission: 'documents:read',
			handler: Effect.fn('documents.title')(function* (
				input: k.output<typeof keyInput>,
				host: Host,
			) {
				const reader = yield* DocumentReader
				return yield* reader.title(input.key, host.actor)
			}),
		}),
	}),
})
export const documentCommands = foundation.Command({
	context: (host: Host) => host,
	operations: ({ command }) => ({
		rename: command({
			input: renameInput,
			result: titleResult,
			classification: 'business',
			permission: 'documents:write',
			handler: (input, host) =>
				Effect.gen(function* () {
					// A nested query stays in the same Effect; no inner runner.
					yield* documents.exec('title', { key: input.key }, host)
					const writer = yield* DocumentWriter
					yield* writer.rename(input.key, input.title, host.actor)
					return input.title
				}).pipe(
					Effect.catchTag('DocumentMissing', () => Effect.fail(new RenameRejected())),
					Effect.withSpan('documents.rename'),
				),
			guard: (host) => (host.actor.length > 0 ? Effect.void : Effect.fail(new AccessDenied())),
			middleware: ({ next }) => next().pipe(Effect.withSpan('documents.command')),
			audit: ({ command: input, result }, host) => ({
				actorId: host.actor,
				operation: 'documents.rename',
				aggregate: { type: 'document', id: input.key },
				metadata: { title: result.title },
			}),
		}),
	}),
})
```

### Request services and shared API setup

Construct the services once in each shared builder provider. Endpoint handlers
do not call `Context.make`, `Effect.runPromise`, or an extra execution helper.
The database Promise wrappers below intentionally preserve unexpected database
failures as defects. For external integrations with expected failures, use
`Effect.tryPromise` and return your own typed error.

`mapError` projects an expected failure to a small `ConvexError` payload. It
receives `unknown`, so narrow it before projection. Defects, interruption,
and combined causes do not become expected failures through this hook; the
adapter preserves those failure causes. The registered function still fails,
which is required for mutation rollback.

```ts
function readerFor(ctx: QueryCtx): Context.Context<DocumentReader> {
	return Context.make(DocumentReader, {
		title: (key, actor) =>
			Effect.gen(function* () {
				const document = yield* Effect.promise(() =>
					ctx.db
						.query('documents')
						.withIndex('by_owner_key', (q) => q.eq('owner', actor).eq('key', key))
						.unique(),
				)
				if (!document) return yield* Effect.fail(new DocumentMissing())
				return document.title
			}),
	})
}
function writerFor(ctx: MutationCtx): Context.Context<DocumentWriter> {
	return Context.make(DocumentWriter, {
		rename: (key, title, actor) =>
			Effect.gen(function* () {
				const document = yield* Effect.promise(() =>
					ctx.db
						.query('documents')
						.withIndex('by_owner_key', (q) => q.eq('owner', actor).eq('key', key))
						.unique(),
				)
				if (!document) return yield* Effect.fail(new DocumentMissing())
				yield* Effect.promise(() => ctx.db.patch(document._id, { title }))
			}),
		audit: (actor, entry) =>
			Effect.promise(() =>
				ctx.db.insert('audits', {
					actor,
					operation: entry.operation,
					documentKey: entry.aggregate.id,
				}),
			).pipe(Effect.asVoid),
	})
}
function authenticatedHost(ctx: QueryCtx) {
	return Effect.gen(function* () {
		const identity = yield* Effect.promise(() => ctx.auth.getUserIdentity())
		if (!identity) return yield* Effect.fail(new AccessDenied())
		return { actor: identity.tokenIdentifier }
	})
}
function projectExpectedError(error: unknown) {
	if (error instanceof DocumentMissing || error instanceof RenameRejected)
		return new ConvexError({ code: 'DOCUMENT_NOT_FOUND' })
	if (error instanceof AccessDenied) return new ConvexError({ code: 'ACCESS_DENIED' })
	return new Error('Document operation failed', { cause: error })
}
const queryApi = effectApiBuilder(nativeQuery, {
	services: readerFor,
	mapError: projectExpectedError,
})
const mutationApi = effectApiBuilder(nativeMutation, {
	services: (ctx) => Context.merge(readerFor(ctx), writerFor(ctx)),
	mapError: projectExpectedError,
})
```

### Consume the domain operations in the API

The Convex callback remains `(ctx, input)`; the domain callback and executor
use input before context/host. Both endpoints are normal native registrations
with argument and return validators. Each handler authenticates the request
and returns the domain Effect. The adapter supplies the services required by
the complete nested program.

```ts
export const documentTitle = queryApi({
	args: { key: v.string() },
	returns: v.object({ title: v.string() }),
	handler: (ctx, input) =>
		Effect.gen(function* () {
			const host = yield* authenticatedHost(ctx)
			return yield* documents.exec('title', input, host)
		}),
})
export const renameDocument = mutationApi({
	args: { key: v.string(), title: v.string() },
	returns: v.object({ title: v.string() }),
	handler: (ctx, input) =>
		Effect.gen(function* () {
			const host = yield* authenticatedHost(ctx)
			return yield* documentCommands.exec('rename', input, host)
		}),
})
```

## Types and schema boundaries

The command accepts `k.input<typeof renameInput>`. Its handler sees
`k.output<typeof renameInput>`, so the title has already been trimmed. The
handler returns a string, which is the input of `titleResult`; the registry's
final result is `{ title: string }`, the output of that transform. Middleware
`next()` returns the handler result before the final result parser, so wrap
or transform that value according to the result schema's input contract.

TypeScript preserves the selected operation's success, expected error, and
service requirements. The title query requires `DocumentReader`; rename
requires `DocumentReader | DocumentWriter` and can fail with `AccessDenied`
or `RenameRejected`. The API builder checks that its provider supplies those
services. A reader-only provider cannot register rename, and an incompatible
handler result cannot pass its declared native return validator.

This is server-side Effect composition. Generated Convex references retain
native argument/result types and visibility; they do not carry Effect's typed
error or service channels over the transport. Clients receive ordinary Convex
results or errors.

For inferred declarations, put `handler` and `guard` before `middleware`, as
above. Middleware-first declarations need explicit callback and error/service
annotations where inference cannot recover the later handler's channels.
`Effect.fn` accepts typed function arguments; `Effect.gen` accepts a generator
whose yielded Effects determine its channels. Use `(input, context) =>
Effect.gen(function* () { ... })` when those values come from the declaration.
A constructed `Effect.gen` program cannot itself receive handler arguments.

## Hooks, replay, and execution scope

A command runs input parsing, observation setup and context resolution, then
permission checking, preparation, middleware, shared and operation guards,
handler, final result parsing, audit construction, aggregate checking, audit
writing, and completion. Observation records the outcome. Query permission
checking runs before its context resolver, followed by middleware, guards,
handler, and result parsing. Command audit/completion hooks do not exist on
queries.

Optional command `prepare(context, input)` returns `{ kind: 'execute',
complete }` or `{ kind: 'replay', result }`. The completion callback receives
the parsed final result. Permission checking still precedes replay. A replay
result is parsed with `replayResult` when supplied, otherwise with `result`,
and skips middleware, guards, handler, audit writing, and completion.
Middleware receives `operation`, parsed `input` (also `command`), `context`,
and `next`; it may provide an enriched context to `next({ context })`.
Each execution allows `next` once. Audit construction sees the original domain
context, and the audit writer sees the original trusted host.

The provider may return a `Context`, a Promise of a Context, or an Effect that
builds a Context. It runs separately for every native invocation. The shared
runner opens an Effect scope, evaluates the provider and handler, and awaits
scope finalizers before returning or throwing. Use `Effect.acquireRelease`
inside a provider for resources that actually need cleanup. Nested domain
operations share that runner and scope; do not run them independently inside
handlers. Cleanup failure remains an endpoint failure, including when it
combines with a handler failure.

## Request scope and nested audit

Every Command, Query and Action `exec` runs inside a request scope. The first
operation of a program opens it, and any `exec` yielded inside that operation's
handler or middleware joins it. Typically this is a bound registry from
`withContext`. Nothing needs to be added to the bound context.

By default (`nestedAudit: 'fold'`), a command nested under an operation that
declares an audit callback does not run its own audit callback and writes no
audit entry. The outermost auditing operation's entry stands for the request;
a failure rolls the nested writes back with it. Actions never fold: each
`ctx.runMutation` commits on its own, so an audited nested action keeps its own
entry even when the enclosing action later fails. A nested operation without an auditing ancestor still audits, for
example a command executed inside a query or inside an action that declares no
audit. An ancestor whose audit callback returns `null` has chosen not to audit
the request.

```ts
const scopedFoundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed' as const, errorCode: 'DOCUMENT_OPERATION_FAILED' }),
	},
	writeAudit: (_host: Host, _entry: AuditEntryInput) => Effect.void,
	// Keep one entry per nested operation instead of one per request.
	nestedAudit: 'separate',
})
```

Audit callbacks receive the scope they entered as a third argument:
`{ root, parent, depth }` for a nested operation and `undefined` for the
outermost one. In `'separate'` mode, use it to correlate entries:

```ts
export const scopedCommands = scopedFoundation.Command({
	context: (host: Host) => host,
	operations: ({ command }) => ({
		touch: command({
			input: keyInput,
			result: k.string(),
			classification: 'business',
			handler: (input) => input.key,
			audit: ({ result }, host, scope) => ({
				operation: 'documents.touch',
				actorId: host.actor,
				aggregate: { type: 'document', id: result },
				metadata: { requestRoot: scope?.root ?? 'documents.touch' },
			}),
		}),
	}),
})
```

The scope lives in the Effect program. An `exec` that a handler runs through
`Effect.runPromise` starts a new program, so it opens its own scope and audits
as a root. Yield nested executions instead.

## Failure audit

A failed mutation rolls back every write it made, including an audit entry
written in the same transaction. Failure audit therefore goes to a host-free
sink:

```ts
import { defineErrorContract } from 'cvx-kit/errors'

const invoiceErrors = defineErrorContract({
	NOT_FOUND: { message: 'Invoice not found', details: {} },
	LIMIT_EXCEEDED: { message: 'Invoice limit exceeded', details: { limit: k.number() } },
})
const auditedFoundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed' as const, errorCode: 'DOCUMENT_OPERATION_FAILED' }),
	},
	writeAudit: (_host: Host, _entry: AuditEntryInput) => Effect.void,
	auditFailure: {
		// Inside queries and mutations there is no fetch: log, and let log streams export it.
		emit: (entry) => console.warn(JSON.stringify({ event: 'operation.failed', ...entry })),
		// Projects failures the registry's own contract does not recognize.
		errors: invoiceErrors,
		// Optional redactors; without them the entry carries neither field.
		details: (details, code) =>
			code === 'LIMIT_EXCEEDED' ? k.object({ limit: k.number() }).parse(details) : undefined,
		input: (_input, operation) => (operation === 'invoices.void' ? { operation } : undefined),
	},
})
```

Each entry carries `kind` (`command`, `query` or `action`), `operation`,
`classification`, `errorCode`, `declared`, the request `root` and the
operation's `depth`. `errorCode` is the declared contract code, or
`UNKNOWN_FAILURE` when neither the registry's contract nor `auditFailure.errors`
recognizes the failure. Raw input, unredacted details, defect messages and
stacks never reach the entry. A redactor that throws or returns anything other
than a plain JSON record leaves its field out.

The innermost operation that fails reports the failure, and enclosing
operations skip the same failure value. So a nested registry's own code
survives, and a nested failure that a parent recovers from is still reported.
Errors thrown by `emit` are ignored; the original failure is unchanged.

Set `argumentFailure` on `createEffectFoundation` to control command and
query `input` rejections. `'validation'` (the default) keeps the decoder's own
failure: a `k` input fails with `KValidationError`, and the API adapter throws it
to the client as `{ code: 'VALIDATION', issues }` even when an `errors`
projection is configured. An Effect Schema or Standard Schema input keeps its
typed failure. `'declared'` throws `INVALID_ARGUMENTS` and reports one entry
with `declared: true`. The default and custom policies report validation
failures as `UNKNOWN_FAILURE`.
Input and details redactors are skipped for these entries. See
[argument validation failures](client-failures.md#argument-validation-failures)
for client decoding and custom policy hooks.

## Raising and recovering declared errors

`effectErrors(contract)` binds `fail` and `attempt` to one declared error
contract. Contracted registries whose `errors` is a `defineErrorContract` result
also receive both on the operations factory:

```ts
import { defineDomainContract } from 'cvx-kit/contracts'

const INVOICE_LIMIT = 3
const invoiceContract = defineDomainContract({
	errors: invoiceErrors,
	commands: {
		'invoices.void': { input: keyInput, result: k.string(), classification: 'business' },
	},
})
export const invoices = auditedFoundation.Command({
	contract: invoiceContract,
	context: (host: Host) => ({
		host,
		load: async (key: string) => (key === 'missing' ? null : { key, total: 1 }),
	}),
	audit: ({ operation, result }, { host }) => ({
		operation,
		actorId: host.actor,
		aggregate: { type: 'invoice', id: result },
	}),
	operations: ({ command, fail, attempt }) => ({
		'invoices.void': command.handler((input, ctx) =>
			Effect.gen(function* () {
				const invoice = yield* attempt(() => ctx.load(input.key))
				if (!invoice) return yield* fail('NOT_FOUND')
				if (invoice.total > INVOICE_LIMIT)
					return yield* fail('LIMIT_EXCEEDED', { limit: INVOICE_LIMIT })
				return invoice.key
			}),
		),
	}),
})
```

`fail(code)` omits details only for codes that declare no detail fields.
`attempt(() => work())` runs sync or async work. A thrown declared error of that
contract, or a `ConvexError` carrying one of its declared envelopes (as
`ctx.runMutation` rethrows it), becomes a typed `DeclaredError`, which
`Effect.catchTag('DeclaredError', ...)` recovers. Every other throw stays a
defect. Combined contracts cannot create errors, so their registries get no
factory helpers; call `effectErrors(memberContract)` for the member you raise
from.

A declared error thrown with `throw errors.create(...)` inside `Effect.gen` is
still a defect in the Effect types. The API adapter's `errors` projection and
failure audit nevertheless recognize it, because the contract created it, so
clients receive its `DeclaredFailure` rather than `UnknownFailure`.

## Action registries

`foundation.Action` runs Convex actions through the command lifecycle: input
and result schemas, context injection, default and operation guards,
middleware, observability, failure audit and the request scope. Handlers call
queries and mutations through `ctx.runQuery`/`ctx.runMutation` with generated
references:

```ts
import { actionGeneric, type FunctionReference, type GenericActionCtx } from 'convex/server'
import { effectErrors } from 'cvx-kit/effect'

type ActionCtx = GenericActionCtx<DataModel>
// In an app this is a generated reference such as `internal.domain.settlement.post`.
declare const postSettlement: FunctionReference<'mutation', 'internal', { key: string }, string>
const { attempt: attemptInvoice } = effectErrors(invoiceErrors)

const actionFoundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed' as const, errorCode: 'DOCUMENT_OPERATION_FAILED' }),
	},
	writeAudit: (_host: Host, _entry: AuditEntryInput) => Effect.void,
	// Typically `ctx.runMutation(internal.audit.write, entry)`.
	writeActionAudit: (_ctx: ActionCtx, entry: AuditEntryInput) =>
		Effect.sync(() => console.info(entry.operation)),
})

export const settlement = actionFoundation.Action({
	context: (ctx: ActionCtx) => ctx,
	operations: ({ action }) => ({
		'settlement.post': action({
			input: keyInput,
			result: k.string(),
			handler: (input, ctx) => attemptInvoice(() => ctx.runMutation(postSettlement, input)),
			audit: ({ command }) => ({
				operation: 'settlement.post',
				actorId: 'system',
				aggregate: { type: 'settlement', id: command.key },
			}),
		}),
	}),
})

export const postSettlementAction = effectApiBuilder(actionGeneric, { errors: invoiceErrors })({
	args: { key: v.string() },
	handler: (ctx: ActionCtx, args: { key: string }) => settlement.exec('settlement.post', args, ctx),
})
```

`classification` defaults to `'action'`, and `audit` is optional per operation
or per registry. An action that audits needs the `writeActionAudit` Foundation
option. Without it the registry fails with `ActionAuditWriterError` on its
first execution, before any handler runs. Each `ctx.runMutation` is its own
transaction, so a completed action's side effects stand even if its audit write
then fails. In that case the action still returns its result and reports
`ACTION_AUDIT_WRITE_FAILED` to `auditFailure`, so callers do not retry work
that already happened. Without an `auditFailure` sink, it logs a payload-free
`action.audit_write_failed` line with `console.error` instead.

Actions have no `prepare`, `replayResult` or `permission` (authorize with a
guard) and no `expose`. Domain contracts can declare them in an `actions`
section; see [Optional domain contracts](./domain-contracts.md).

## Convex boundaries and observed support

A domain query is a reusable read operation; its name does not choose the
native function kind. A native Convex query must perform deterministic database
reads. Native mutations can write, and a failed command, result validator,
audit writer, completion hook, or awaited cleanup rolls back that mutation's
writes. Actions are the place for HTTP and other external integrations.
An action's separate `ctx.runMutation` calls are separate transactions: a
later failure does not undo an earlier successful mutation.

The packed public facade was compiled and executed under npm and Bun with
Effect 4.0.1 and `convex-helpers` 0.1.123. Legacy packed consumers also ran with
Effect absent. Local Convex 1.45.0 checks exercised ordinary, generator, and
named-function query composition; request cleanup; expected and combined
failures; mutation validation and lifecycle rollback; and an action using
loopback HTTP with separate mutation transactions. `Effect.withSpan` was
accepted in those programs; this does not establish exported telemetry,
background fibers, arbitrary concurrency, or every Effect runtime capability
in Convex.

The standalone packed compiler includes `ESNext.Disposable` in its library
set for Effect 4 declarations. If your project's TypeScript environment does
not already provide those globals, include that library as well.

## Adopt one domain at a time

Keep existing Promise registries and API endpoints while adding the optional
facade for a new domain. Move each operation's handler beside its schemas and
hooks, switch domain callbacks to input-first arguments, and return the new
registry's lazy Effect to a shared API adapter. A normal async handler works
in the cohesive declaration without a generator; wrap expected Promise failures
only when you want a typed error channel.

The [command guide](./commands.md) documents the current lifecycle and migration
steps; the [deprecated API reference](./commands-legacy.md) retains old examples.
The [authentication guide](./auth.md)
shows the shared `createEffectAuthFunctions(config, policies)` factory and how
to wrap individual trusted builders with `effectApiBuilder`, so auth,
tenancy, validators, row-level policies, and triggers run through their
existing builder before Effect request services are provisioned.

For an app-wide foundation, configure `query`, `mutation`, and `action` policies
once with `createEffectAuthFunctions` and explicit separate system policies.
Query handles bind readers, mutation handles bind the secured triggered writer,
and action handles use `runMutation` rather than a mutation database.

Optional request context can also be added through the existing Effect API adapter's
`context` callback. Bind selected registries with `commands.withContext(value)`
and consume `ctx.commands.exec(name, input)` through the application's existing
function helper names. Keep dependencies local to each feature; explicit execution
and input-only command handlers remain supported. See [optional context injection](./command-context.md).

See [Optional domain contracts](./domain-contracts.md) for shared declarations, named implementations, and registry audit defaults in both Effect and Promise registries.
