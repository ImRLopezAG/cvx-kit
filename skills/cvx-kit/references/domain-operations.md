# Domain operations on Convex

Declare operations beside their handlers, inject the application's repositories, and register the native functions at the application boundary. The domain registry owns decoding and the command lifecycle. Convex owns function authorization, transaction rollback, durable workflow journals, and scheduling.

The complete TypeScript module below is mirrored in `test/domain-operation-guide-types.ts` for strict compilation. All TypeScript in this guide belongs to that one module; there are no standalone handler fragments. It uses public `cvx-kit/*` imports, real Convex builders, an injected document repository, and generated references from the native acceptance fixture. Its document schema and generic builders let the example compile independently; an application imports its own `mutation`, `query`, and internal builders from `./_generated/server`. The integrated rename portion imports the exact registry from `test/fixture-effect/convex/integratedRename.ts` and binds its real generated references. The document create/receipt example remains separate.

The examples use the recommended Effect command API even for ordinary handlers. The older `Foundation.Command` facade is deprecated and retained for existing consumers without Effect; use [the migration guide](./commands.md) when moving those domains. Neutral contracts, errors, idempotency, workflow, and tool facades remain available without Effect. Import `cvx-kit/effect` only when the application supplies its Effect peer.

## Declare a cohesive domain

Use `createEffectFoundation` from `cvx-kit/effect` to bind the application's audit and permission capabilities. Both ordinary and Effect handlers use the same operation factory. Define `create` and `rename` in the command registry and `get` in the query registry. Query declarations cannot accept command-only preparation, audit, or receipt hooks.

The compile fixture defines `Host` with the current secured writer, tenant, actor, current role, repository, and a trusted idempotency invocation. It supplies `foundation.writeAudit` with that same writer. The ordinary `ordinaryCommands.create` handler accesses the repository through its host. The `commands.create` alternative uses the same input, result, receipt preparation, and audit lifecycle.

The `Effect.fn` version resolves `Documents` only when the operation executes.

`Effect.gen` works in the same declaration: `commands.rename` resolves the injected repository and changes the title. `queries.get` requires only `DocumentReader` and fails with the declared `MISSING` error when no document exists.

Command declarations also provide `classification` and `audit`. The audit callback receives `{ command, result }` and the domain host; use `result.id`, the trusted `host.actor`, and an explicit operation name. The injected audit writer persists the entry in the current mutation transaction. A nested generated CRUD command can own the audit instead; avoid writing two execution audits for one command.

`commands.exec('create', input, host)` returns a lazy Effect. Its success, declared failures, and required services are inferred from the selected operation's decoders and callbacks. The `serverCreate` function composes it server side and provides `Documents` at the invocation boundary. At the native API boundary, `securedMutation` provides that service from the authenticated context instead.

Do not call `Effect.runPromise` from the middle of a domain operation to discharge its dependencies. Keep error and service channels visible until the native API adapter provides them.

## Register the native API

`effectApiBuilder` accepts Convex validators; `effectZodApiBuilder` accepts Zod definitions. Pass the application's secured builder, such as `auth.authMutation`, so its trusted context is constructed before the service provider runs. The compile fixture uses `createAuthFunctions` from `cvx-kit/auth`, tenant security for documents/receipts/audits, and owner-only write rules. The repository receives the resulting secured writer.

The host takes tenant, actor, and writer from the secured context and captures the raw title before the domain decoder runs. The fixture also registers `get` through `auth.authQuery`, injecting a separate `DocumentReader` capability that exposes only repository reads.

Each invocation gets its own provider and scope. If service initialization or scoped cleanup fails, the native mutation must reject so its business, audit, and receipt writes roll back. Ordinary throws/rejections and defects remain failures; they are not silently chosen as one declared domain error.

The fixture has a negative example: an API provider returning `Context.empty()` cannot register a handler requiring `Documents`. The `invokeNativeCreate` function demonstrates native consumption with `ctx.runMutation(api.idempotency.save, { key, payload })` using the real registered fixture mutation. When installing the local document module in an application, generate its own references with Convex codegen before calling its `create` and `get` exports. The native function reference carries its args/result and kind; it does not transport the server Effect's `E` or `R` types.

`zid('documents')` brands strings in Zod parsing. A registered native `v.id('documents')` validator establishes the real Convex ID/table boundary. The host must enforce native IDs when raw tool or network strings reach a registered function; a brand alone does not prove a valid document ID.

## Choose each contract explicitly

Import `zodContract`, `standardContract`, and `convexContract` from `cvx-kit/contracts` for neutral codecs. Ordinary operation definitions can also use Zod schemas directly and may decode asynchronously. Standard Schema supplies validation, not a portable schema AST or encoder; do not derive native validators from a black-box contract. Import `effectContract`, `effectSchema`, or `effectStandardSchema` from `cvx-kit/effect` when decoding itself requires Effects or services.

Keep the raw input, decoded domain result, retained final result, and public wire projection distinct. A title-trimming input decoder belongs inside the operation. A fresh-result transform must not run again on receipt replay or native workflow journal replay. Use a separate `replayResult` schema for the retained final form and a public wire schema/projector when exposing only selected fields.

Generated CRUD uses `createEffectCrud` and `tenantTable` with explicit command/server/public masks. The fixture's `documentCrud` binds the same foundation, writer, actor, and indexed repository. The read configuration supplies `get` and indexed pagination with `maxPageSize: 20`; its public projection returns only the title. Generated writes retain native trigger/RLS behavior through the supplied secured writer. Application configuration determines which rules and triggers exist.

## Project declared failures safely

The `get` handler fails with `errors.create('MISSING', { id })`. Pass the contract to the Effect API builder. The native boundary emits a versioned JSON-safe `ConvexError` payload only for a valid singular declared failure. Safe details must be intentionally chosen; do not include service state, credentials, internal causes, or stack traces.

On consumption, call `errors.decode(error.data)` after recognizing a native `ConvexError`. The result is a checked `DeclaredFailure` union or `UnknownFailure`; an arbitrary payload does not become a domain error through a cast. Defects, interruptions, composite causes, malformed details, and undeclared errors follow the unknown path. Never parse workflow journal error strings to recover typed failures.

## Commit receipts with business writes

Import `captureIdempotencyInvocation` and `transactionalIdempotency` from `cvx-kit/idempotency`, or use `effectTransactionalIdempotency` for Effect callbacks. The fixture's adapter closes over the secured mutation writer and implements authorization, indexed lookup, claim, and completion. Receipt completion, document creation, and command audit share one transaction.

The `create` native handler captures identity before decoding the raw request. The fingerprint is derived from the raw title; trimming is performed only by the operation decoder.

Supply `prepare: host => receipts(host.db, host.tenant, host.actor, host.role).prepare(host.invocation)` and `replayResult: document` in the command. The retained final result is validated separately on replay. A compatible retry returns it without another business write, result transform, or execution audit. Authorization still runs before receipt replay: the adapter checks the current owner role and the trusted tenant/actor scope before returning a retained result. Stale versions, conflicting fingerprints, malformed results, pending rows, and duplicate identities fail explicitly.

The host owns authorization scope, compatible deployment policy, fingerprint equivalence, retention, and expiration. Deleting a receipt removes dedupe protection; do not promise indefinite exactly-once execution. A caller key alone is not authority. Replay skips execution guards and middleware; required permission checks, context resolution, and receipt authorization must still authorize the retained result. External actions cannot share this mutation transaction; use provider dedupe or provider-specific reconciliation when a response is lost.

## Run native workflow steps

Import `workflowBinding`, `workflowExecution`, and `runWorkflowStep` from `cvx-kit/workflow`. Pair the operation's explicit wire schemas and version metadata with an actual generated query, mutation, or action reference. The rename fixture binds `internal.integratedRename.applyRename`, the same registered audited mutation reached by the direct API and selected tool. A wrong kind is a compile error. The separate create example demonstrates receipt protection; rename does not add a receipt.

The `nativeWorkflowStep` function calls that registered reference through `stepBinding`. `startNativeRename` invokes the secured `api.integratedRename.start`, which issues the execution descriptor and starts the configured `WorkflowManager` component. Its native workflow waits for a host event, then executes this binding through an actual component step. Callers supply only the note ID and raw title. The execution capability, actor and tenant come from the authenticated host.

The host-issued execution descriptor contains `version`, operation/contract/binding versions, stable business `run`, opaque trusted `capability`, logical `occurrence`, and plain `args`. Reconstruct current authority and invocation services inside each newly executed native step. Replayed completed steps remain historical journal results. Status access also requires current authority.

Receipt identity uses stable business run plus logical occurrence within authority scope. A loop's second occurrence needs a different identity. Delivery attempt counts and host callback generations are telemetry/fencing data and must not change that business identity.

`runWorkflowStep` returns the raw wire result inferred from the generated reference (`ContractInput<Result>`); it does not apply the binding result transform on journal replay. `terminalWorkflowAttempt` validates a successful result against its result contract but returns the original raw wire value in `{ version: 1, kind: "succeeded", value }`. For a known terminal failure, its `terminal` callback must select safe details from the rejected native error. The failure contract decodes that projection, and the helper checks the decoded value is plain Convex data before returning `{ version: 1, kind: "failed", error }`. The failure is decoded and sanitized; success remains raw wire. Unknown or retryable errors must return `undefined` from the classifier so the original error escapes.

A typed-terminal mutation must reject its inner native mutation before an outer binding catches and projects the safe terminal outcome. Use `terminalWorkflowAttempt` with the outer mutation path only after the host has verified sub-mutation rollback and atomic journaling on its pinned component/backend. The action fallback requires evidence from `receiptWorkflowMutation` and a registered inner mutation that commits its U5 receipt with business/audit writes. Its outer action can fail after that commit but before journaling; such native failure does not establish rollback.

Action step retry defaults to disabled in `runWorkflowStep`, including when manager defaults enable retries. Opt in deliberately through native retry options. Declared terminal envelopes should not retry; transient actions may exhaust their opted-in attempts. Unknown provider outcomes require provider dedupe or reconciliation before retry.

Use `workflowStatusBindings` with host-owned transactional generation guards for callback, reconciliation, cancellation, and restart. A successful native journal value containing a terminal domain failure maps to failed host status. Failed callbacks leave native terminal status available for explicit authorized reconciliation. A committed receipt can be reported separately while native workflow status remains failed. Cancellation does not undo committed steps or running external requests; late completion cannot replace canceled host status or a newer generation.

The pinned native `WorkflowManager.restart` retains the original completion callback context. Incrementing the host generation does not update that context: the restarted completion callback still carries the old generation and is correctly ignored. The host must explicitly reconcile native status and retained outcomes using the new generation, or use a separately registered new run with fresh callback context. `workflowStatusBindings` does not automatically rebind native callback generations. Preserve the stable business receipt identity independently of callback fencing.

The native acceptance driver exercises paused-run recovery across a compatible redeployment and rejects changed recorded step arguments through the real journal. Listed compatibility metadata is an explicit host decision, not automatic compatibility discovery.

The actual rename declaration lives in `test/fixture-effect/convex/integratedRename.ts`. Its `commands.rename` resolves the injected `Notes` repository and produces only `{ title }`. The registered `applyRename` adapter supplies that repository per invocation, resolves the host-issued capability, rechecks current permission, and reconstructs the tenant/owner secured writer with native triggers. Permission, rename and actor audit execute inside the same native mutation. The asynchronous title decoder runs once there; neither the tool converter nor workflow binding normalizes it again. `rejectMissingRenameService` imports this exact registry and verifies that an API provider returning `Context.empty()` cannot close its required `Notes` service.

The native driver independently reads business, audit and trigger state after direct API, selected tool and workflow calls. It also pauses a real component workflow, revokes authority, and verifies the newly executed step leaves those writes unchanged. Completed journal results remain historical; current checks apply when the native mutation executes again.

## Select operation tools explicitly

Use `registry.expose(owner, key)` and `bindOperationExecutor` from `cvx-kit/agent-tools` to select one operation and bind its executor. `createOperationTools` exposes only the supplied entries. `renameDocumentTool` consumes `selectedRename`, exported by the actual injected rename registry, and invokes `api.integratedRename.rename` through `invokeNativeRename`. That secured API issues a host capability and calls `internal.integratedRename.applyRename`, exactly the mutation bound by the workflow step. There is one rename declaration and one audited native execution boundary across all three surfaces.

The separate `createDocumentTool` function binds the selected create operation to its real generated native function through `invokeNativeCreate`. The host supplies the idempotency key outside the tool arguments. Construct a tool binding for each logical create request. Reuse that request's key for compatible retries; give distinct requests distinct keys. Reusing one binding for independent writes can replay the earlier result or reject conflicting input.

Tool arguments carry only operation input. Tenant, actor, permissions, credentials, and service authority come from the trusted host and its secured reference. The owner and key pair identify the selected operation; they are correlation tags, not authorization credentials. The trusted host must bind an executor to the correct secured native reference. The adapter cannot authorize an arbitrary host callback or repair its public projection.

Supply a converter with `dialect: operationToolDialect` and a JSON schema representing the raw wire input. The fixture's title schema is:

```json
{
	"type": "object",
	"properties": { "title": { "type": "string" } },
	"required": ["title"],
	"additionalProperties": false
}
```

Do not turn the selected operation's title transforms into an unrelated tool-side decoder. The same registered operation remains responsible for decoding, authority, result validation, receipt completion, and audit. Tool invocation returns `Success`, a validated declared failure when a contract is supplied, or `UnknownFailure`; mutation failures must cross the native transaction boundary before becoming failure data.

No agent framework, model invocation, React state, or automatic registry exposure is required by these server bindings. The application supplies its agent framework adapter and explicitly chooses which secured references an agent may execute.

## Compile the complete example

The module uses public package imports and local generated application references. Preserve this relative layout in a consumer fixture:

```text
consumer/
  domain-operation-guide-types.ts
  fixture-effect/convex/
    _generated/{api.d.ts,api.js,server.d.ts,server.js,dataModel.d.ts}
    actions.ts, crud.ts, domain.ts, functions.ts, http.ts
    idempotency.ts, operationTools.ts, workflowNative.ts, workflowProof.ts
    schema.ts
```

Copy the actual native fixture modules and generated files together: `api.d.ts` imports every registered module, and `server.d.ts` uses the generated model derived from `schema.ts`. Do not replace generated references with `any`, fabricated `FunctionReference` casts, or handwritten API stubs. Mount the workflow component through the fixture's `convex.config.ts` when generating or running the native app.

The checked versions are Effect `4.0.1`, Convex `1.45.0`, convex-helpers `0.1.124`, Zod `4.5.4`, and `@convex-dev/workflow` `0.4.6`; compilation also needs TypeScript (this checkout uses `7.0.2`) and `@types/node` (here `26.6.1`) because the registered action fixture uses `process`. Install the packed `cvx-kit` package and its required peers. Use ESM with strict TypeScript, bundler module resolution, ES2025 and DOM libraries, `types: ["node"]`, and no emit. An installed consumer must resolve `cvx-kit/*` through package exports without source path aliases.

The module includes compile-only negative assertions for a missing service provider and incompatible native function kind, arguments, and result. Preserve the `@ts-expect-error` assertions in the compilation fixture. They are not application registrations to execute. Typechecking proves public API compatibility; it does not establish native rollback, callback delivery, provider dedupe, or runtime acceptance.

<details>
<summary>Complete server module and compile-only assertions</summary>

```ts
import { Context, Effect } from 'effect'
import { z } from 'zod'
import { ConvexError, v, type Value } from 'convex/values'
import {
	defineSchema,
	defineTable,
	mutationGeneric,
	queryGeneric,
	actionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	internalActionGeneric,
	type DataModelFromSchemaDefinition,
	type MutationBuilder,
	type QueryBuilder,
	type ActionBuilder,
	type GenericDatabaseWriter,
	type GenericDatabaseReader,
} from 'convex/server'
import { createAuthFunctions } from 'cvx-kit/auth'
import {
	createEffectFoundation,
	createEffectCrud,
	effectApiBuilder,
	effectZodApiBuilder,
} from 'cvx-kit/effect'
import { defineErrorContract } from 'cvx-kit/errors'
import { zid, tenantTable } from 'cvx-kit/zod-table'
import { zodContract, standardContract, convexContract } from 'cvx-kit/contracts'
import {
	captureIdempotencyInvocation,
	transactionalIdempotency,
	type IdempotencyInvocation,
} from 'cvx-kit/idempotency'
import { workflowBinding, runWorkflowStep, type WorkflowExecution } from 'cvx-kit/workflow'
import {
	bindOperationExecutor,
	createOperationTools,
	operationToolDialect,
} from 'cvx-kit/agent-tools'
import type { WorkflowCtx } from '@convex-dev/workflow'
import { internal, api } from './fixture-effect/convex/_generated/api'
import type { ActionCtx } from './fixture-effect/convex/_generated/server'
import { nativeIdempotencyOperation } from './fixture-effect/convex/idempotency'
import {
	commands as integratedRenameCommands,
	selectedRename,
	type Host as IntegratedRenameHost,
} from './fixture-effect/convex/integratedRename'
import { internalMutation as fixtureInternalMutation } from './fixture-effect/convex/_generated/server'
import type { Id as FixtureId } from './fixture-effect/convex/_generated/dataModel'

// Standalone type fixture: these are real native builders specialized to this schema.
// An application imports its equivalent generated builders from ./_generated/server.
const schema = defineSchema({
	documents: defineTable({ tenant: v.string(), title: v.string() }).index('by_tenant', ['tenant']),
	audits: defineTable({ tenant: v.string(), actor: v.string(), operation: v.string() }),
	receipts: defineTable({
		tenant: v.string(),
		operation: v.string(),
		scope: v.string(),
		key: v.string(),
		versions: v.object({
			operation: v.string(),
			contract: v.string(),
			binding: v.string(),
			fingerprintPolicy: v.string(),
		}),
		fingerprint: v.string(),
		state: v.union(v.literal('pending'), v.literal('completed')),
		result: v.optional(v.any()),
	}).index('by_identity', ['operation', 'scope', 'key']),
})
type Model = DataModelFromSchemaDefinition<typeof schema>
const mutation: MutationBuilder<Model, 'public'> = mutationGeneric
const query: QueryBuilder<Model, 'public'> = queryGeneric
const action: ActionBuilder<Model, 'public'> = actionGeneric
const internalMutation: MutationBuilder<Model, 'internal'> = internalMutationGeneric
const internalQuery: QueryBuilder<Model, 'internal'> = internalQueryGeneric
const internalAction: ActionBuilder<Model, 'internal'> = internalActionGeneric
const errors = defineErrorContract({
	MISSING: { message: 'Document missing', details: { id: z.string() } },
})
const document = z.object({ id: zid('documents'), title: z.string() }).strict()
const createInput = z.object({ title: z.string().trim().min(1) }).strict()
const renameInput = z.object({ id: zid('documents'), title: z.string().trim().min(1) }).strict()
const getInput = z.object({ id: zid('documents') }).strict()
type Document = z.infer<typeof document>
interface Repository {
	create(title: string): Promise<Document>
	rename(id: Document['id'], title: string): Promise<Document>
	get(id: Document['id']): Promise<Document | null>
}
class Documents extends Context.Service<Documents, Repository>()('Documents') {}
class DocumentReader extends Context.Service<DocumentReader, Pick<Repository, 'get'>>()(
	'DocumentReader',
) {}
type ReadHost = { db: GenericDatabaseReader<Model> }
const bounds = {
	maxDepth: 8,
	maxNodes: 100,
	maxBytes: 4096,
	maxArrayLength: 20,
	maxObjectFields: 20,
}
function receipts(
	db: GenericDatabaseWriter<Model>,
	tenant: string,
	actor: string,
	role: 'owner' | null,
) {
	const trustedScope = JSON.stringify([tenant, actor])
	return transactionalIdempotency({
		final: { replayResult: document, encode: (value) => value },
		authorize: (invocation) => {
			if (role !== 'owner') throw new Error('Receipt permission denied')
			if (invocation.identity.scope !== trustedScope) throw new Error('Receipt scope denied')
		},
		lookup: (identity) =>
			db
				.query('receipts')
				.withIndex('by_identity', (q) =>
					q.eq('operation', identity.operation).eq('scope', identity.scope).eq('key', identity.key),
				)
				.take(2),
		fingerprint: (canonical) => canonical,
		claim: (identity, receipt) =>
			db.insert('receipts', {
				tenant,
				...identity,
				versions: receipt.versions,
				fingerprint: receipt.fingerprint,
				state: 'pending',
			}),
		complete: (id, receipt) => db.patch(id, { state: 'completed', result: receipt.result }),
	})
}
type Host = {
	db: GenericDatabaseWriter<Model>
	tenant: string
	actor: string
	role: 'owner' | null
	repository: Repository
	invocation: IdempotencyInvocation
}
const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'DOCUMENT_FAILURE' }),
	},
	writeAudit: (host: Host, entry) =>
		host.db
			.insert('audits', { tenant: host.tenant, actor: host.actor, operation: entry.operation })
			.then(() => undefined),
})
export const ordinaryCommands = foundation.Command({
	context: (host: Host) => host,
	operations: ({ command }) => ({
		create: command({
			input: createInput,
			result: document,
			replayResult: document,
			classification: 'business',
			prepare: (host) =>
				receipts(host.db, host.tenant, host.actor, host.role).prepare(host.invocation),
			handler: async (input, host) => host.repository.create(input.title),
			audit: ({ result }, host) => ({
				operation: 'documents.create',
				actorId: host.actor,
				aggregate: { type: 'document', id: result.id },
				payload: {},
			}),
		}),
	}),
})
export const commands = foundation.Command({
	context: (host: Host) => host,
	operations: ({ command }) => ({
		create: command({
			input: createInput,
			result: document,
			replayResult: document,
			classification: 'business',
			prepare: (host) =>
				receipts(host.db, host.tenant, host.actor, host.role).prepare(host.invocation),
			handler: Effect.fn('Documents.create')(function* (input: { title: string }) {
				const repository = yield* Documents
				return yield* Effect.promise(() => repository.create(input.title))
			}),
			audit: ({ result }, host) => ({
				operation: 'documents.write',
				actorId: host.actor,
				aggregate: { type: 'document', id: result.id },
				payload: {},
			}),
		}),
		rename: command({
			input: renameInput,
			result: document,
			classification: 'business',
			handler: (input) =>
				Effect.gen(function* () {
					const repository = yield* Documents
					return yield* Effect.promise(() => repository.rename(input.id, input.title))
				}),
			audit: ({ result }, host) => ({
				operation: 'documents.write',
				actorId: host.actor,
				aggregate: { type: 'document', id: result.id },
				payload: {},
			}),
		}),
	}),
})
export const queries = foundation.Query({
	context: (host: ReadHost) => host,
	operations: ({ query }) => ({
		get: query({
			input: getInput,
			result: document,
			handler: ({ id }) =>
				Effect.gen(function* () {
					const repository = yield* DocumentReader
					const value = yield* Effect.promise(() => repository.get(id))
					if (!value) return yield* Effect.fail(errors.create('MISSING', { id }))
					return value
				}),
		}),
	}),
})
function repository(db: GenericDatabaseWriter<Model>, tenant: string): Repository {
	return {
		create: async (title) => ({ id: await db.insert('documents', { tenant, title }), title }),
		rename: async (id, title) => {
			await db.patch(id, { title })
			return { id, title }
		},
		get: async (id) => {
			const row = await db.get(id)
			return row ? { id: row._id, title: row.title } : null
		},
	}
}
const auth = createAuthFunctions<Model, 'owner'>({
	query,
	mutation,
	action,
	internalQuery,
	internalMutation,
	internalAction,
	getAuthUser: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity()
		return identity ? { id: identity.subject } : null
	},
	mapRole: (role) => (role === 'owner' ? 'owner' : null),
	adminRoles: ['owner'],
	security: {
		tenancy: { tables: ['documents', 'receipts', 'audits'] },
		rules: (bundle) => ({
			documents: {
				insert: async () => bundle.role === 'owner',
				modify: async () => bundle.role === 'owner',
			},
			receipts: {
				insert: async () => bundle.role === 'owner',
				modify: async () => bundle.role === 'owner',
			},
			audits: { insert: async () => bundle.role === 'owner' },
		}),
	},
})
const securedMutation = effectZodApiBuilder(auth.authMutation, {
	services: (ctx) => Context.make(Documents, repository(ctx.db, ctx.tenant)),
	errors,
})
export const create = securedMutation({
	args: { key: z.string().min(1), title: z.string() },
	returns: document,
	handler: (ctx, args) => {
		const invocation = captureIdempotencyInvocation({
			binding: { kind: 'mutation', atomicity: 'same-mutation' },
			identity: {
				operation: 'documents.create',
				scope: JSON.stringify([ctx.tenant, ctx.actor.userId]),
				key: args.key,
			},
			versions: { operation: '1', contract: '1', binding: '1', fingerprintPolicy: 'raw-1' },
			rawInput: { title: args.title },
			canonical: { bounds },
		})
		const host: Host = {
			db: ctx.db,
			tenant: ctx.tenant,
			actor: ctx.actor.userId,
			role: ctx.role,
			repository: repository(ctx.db, ctx.tenant),
			invocation,
		}
		return commands.exec('create', { title: args.title }, host)
	},
})
const securedQuery = effectZodApiBuilder(auth.authQuery, {
	services: (ctx) =>
		Context.make(DocumentReader, {
			get: async (id) => {
				const row = await ctx.db.get(id)
				return row ? { id: row._id, title: row.title } : null
			},
		}),
	errors,
})
export const get = securedQuery({
	args: getInput.shape,
	returns: document,
	handler: (ctx, args) => queries.exec('get', args, ctx),
})
export function serverCreate(host: Host, input: { title: string }) {
	return commands
		.exec('create', input, host)
		.pipe(Effect.provideService(Documents, host.repository))
}
const missingProvider = effectApiBuilder(internalMutation, { services: () => Context.empty() })
// @ts-expect-error The API cannot close an invocation while Documents remains unprovided.
missingProvider({
	args: { id: v.id('documents') },
	returns: v.object({ id: v.id('documents'), title: v.string() }),
	handler: (_ctx, { id }) =>
		Effect.gen(function* () {
			const repository = yield* Documents
			const value = yield* Effect.promise(() => repository.get(id))
			if (!value) return yield* Effect.fail(errors.create('MISSING', { id }))
			return value
		}),
})

// References come from registered native functions.
const stepBinding = workflowBinding({
	kind: 'mutation',
	operation: 'integratedRename.rename',
	operationVersion: '1',
	contractVersion: '1',
	bindingVersion: '1',
	args: z.object({ id: z.string(), title: z.string() }).strict(),
	result: z.object({ title: z.string() }).strict(),
	reference: internal.integratedRename.applyRename,
})
export function nativeWorkflowStep(
	step: WorkflowCtx,
	execution: WorkflowExecution<{ id: FixtureId<'crudNotes'>; title: string }>,
) {
	return runWorkflowStep(step, stepBinding, execution, { inline: true })
}
workflowBinding({
	kind: 'action',
	operation: 'integratedRename.rename',
	operationVersion: '1',
	contractVersion: '1',
	bindingVersion: '1',
	args: z.object({ id: z.string(), title: z.string() }).strict(),
	result: z.object({ title: z.string() }).strict(),
	// @ts-expect-error A registered mutation reference cannot be an action binding.
	reference: internal.integratedRename.applyRename,
})

workflowBinding({
	...stepBinding,
	args: z.object({ id: z.string(), title: z.number() }),
	// @ts-expect-error The real mutation takes a string title, not a numeric title.
	reference: internal.integratedRename.applyRename,
})
workflowBinding({
	...stepBinding,
	result: z.object({ title: z.number() }),
	// @ts-expect-error The real mutation returns a string title, not a numeric title.
	reference: internal.integratedRename.applyRename,
})

// This registry is the exact declaration executed by the registered acceptance fixture.
// The native adapter provides its Notes repository for each new invocation.
export function rejectMissingRenameService(host: IntegratedRenameHost) {
	const missingRenameProvider = effectApiBuilder(fixtureInternalMutation, {
		services: () => Context.empty(),
	})
	// @ts-expect-error The actual rename operation still requires its injected Notes service.
	missingRenameProvider({
		args: { id: v.string(), title: v.string() },
		returns: v.object({ title: v.string() }),
		handler: (_ctx, input) => integratedRenameCommands.exec('rename', input, host),
	})
}
export function invokeNativeRename(ctx: ActionCtx, input: { id: string; title: string }) {
	return ctx.runMutation(api.integratedRename.rename, input)
}
export function startNativeRename(ctx: ActionCtx, input: { id: string; title: string }) {
	return ctx.runMutation(api.integratedRename.start, input)
}
export function renameDocumentTool(ctx: ActionCtx) {
	const executor = bindOperationExecutor(selectedRename, {
		owner: selectedRename.owner,
		key: selectedRename.key,
		execute: (input) => invokeNativeRename(ctx, input),
	})
	return createOperationTools({
		renameDocument: {
			operation: selectedRename,
			executor,
			description: 'Rename through the same authorized audited native boundary',
			converter: {
				dialect: operationToolDialect,
				convert: () => ({
					type: 'object',
					properties: { id: { type: 'string' }, title: { type: 'string' } },
					required: ['id', 'title'],
					additionalProperties: false,
				}),
			},
		},
	})
}

// Tools explicitly select a raw descriptor and execute the real secured native reference.
export function invokeNativeCreate(ctx: ActionCtx, key: string, payload: { title: string }) {
	return ctx.runMutation(api.idempotency.save, { key, payload })
}

export function createDocumentTool(ctx: ActionCtx, key: string) {
	const selected = nativeIdempotencyOperation
	const executor = bindOperationExecutor(selected, {
		owner: selected.owner,
		key: selected.key,
		execute: (payload) => invokeNativeCreate(ctx, key, payload),
	})
	return createOperationTools({
		createDocument: {
			operation: selected,
			executor,
			description: 'Create an authorized document title',
			converter: {
				dialect: operationToolDialect,
				convert: () => ({
					type: 'object',
					properties: { title: { type: 'string' } },
					required: ['title'],
					additionalProperties: false,
				}),
			},
		},
	})
}
export function decodeRemoteFailure(error: ConvexError<Value>) {
	return errors.decode(error.data)
}

const documentTable = tenantTable('documents', () => ({ title: z.string() }), {
	commandFields: ['title'],
	serverFields: [],
	publicFields: ['title'],
})
export const documentCrud = createEffectCrud({
	foundation,
	table: documentTable,
	context: (host: Host) => host,
	aggregateType: 'document',
	actor: (host) => host.actor,
	enrich: (host) => ({ tenant: host.tenant }),
	read: {
		maxPageSize: 20,
		project: (row) => ({ title: row.title }),
		get: (host, id) => host.db.get(id),
		list: (host, options) =>
			host.db
				.query('documents')
				.withIndex('by_tenant', (q) => q.eq('tenant', host.tenant))
				.paginate(options),
	},
})
export const rawTitleContract = zodContract(z.string().trim())
export const standardTitleContract = standardContract(z.string())
export const nativeDocumentIdContract = convexContract(v.id('documents'))
```

</details>
