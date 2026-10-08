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
