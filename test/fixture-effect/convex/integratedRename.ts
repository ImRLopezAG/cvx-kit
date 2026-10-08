import { WorkflowManager, vWorkflowId, vResultValidator } from '@convex-dev/workflow'
import { v } from 'convex/values'
import type { GenericDatabaseWriter } from 'convex/server'
import { createAuthFunctions } from 'cvx-kit/auth'
import { createEffectFoundation, effectApiBuilder } from 'cvx-kit/effect'
import {
	bindOperationExecutor,
	createOperationTools,
	operationToolDialect,
} from 'cvx-kit/agent-tools'
import { composeRules, createTenantRules, wrapDatabaseWriter } from 'cvx-kit/tenancy'
import { createTriggers, tenantOwnership } from 'cvx-kit/triggers'
import {
	workflowBinding,
	workflowExecution,
	runWorkflowStep,
	type WorkflowExecution,
} from 'cvx-kit/workflow'
import { Context, Effect } from 'effect'
import { z } from 'zod'
import { api, internal, components } from './_generated/api'
import {
	action,
	mutation,
	query,
	internalAction,
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from './_generated/server'
import type { DataModel, Id } from './_generated/dataModel'

const rawInput = z.object({ id: z.string(), title: z.string() }).strict()
// Non-idempotent marker makes accidental double decoding visible in stored state.
const decodedInput = rawInput.extend({
	title: z.string().transform(async (title) => `${title.trim().toLowerCase()}!`),
})
const result = z.object({ title: z.string() }).strict()
type Value = z.infer<typeof result>
type Authority = { actor: string; tenant: string; scope: string }
export type Host = Authority & { db: GenericDatabaseWriter<DataModel> }
interface Repository {
	rename(id: string, title: string, host: Host): Promise<void>
}
export class Notes extends Context.Service<Notes, Repository>()('IntegratedRenameNotes') {}
const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'INTEGRATED_RENAME_FAILED' }),
	},
	checkPermission: (host: Host) =>
		Effect.promise(async () => {
			const permission = await host.db
				.query('idempotentPermissions')
				.withIndex('by_scope', (q) => q.eq('scope', host.scope))
				.unique()
			if (!permission?.allowed) throw new Error('INTEGRATED_RENAME_DENIED')
		}),
	writeAudit: (host: Host, entry) =>
		Effect.promise(() =>
			host.db.insert('crudAudits', {
				operation: entry.operation,
				actor: entry.actorId,
				id: entry.aggregate.id,
			}),
		),
})
export const commands = foundation.Command({
	context: (host: Host) => host,
	operations: ({ command }) => ({
		rename: command({
			input: decodedInput,
			result,
			classification: 'business',
			permission: 'notes.rename',
			handler: (input, host) =>
				Effect.gen(function* () {
					const repository = yield* Notes
					yield* Effect.promise(() => repository.rename(input.id, input.title, host))
					return { title: input.title }
				}),
			audit: ({ command }, host) => ({
				operation: 'integratedRename.rename',
				actorId: host.actor,
				aggregate: { type: 'note', id: command.id },
			}),
		}),
	}),
})
export const selectedRename = commands.expose(Symbol('integrated-rename'), 'rename')
const triggers = createTriggers<DataModel>()
tenantOwnership(triggers, 'crudNotes')
triggers.register('crudNotes', async (ctx, change) => {
	await ctx.innerDb.insert('crudHistory', { id: change.id, operation: change.operation })
})
const auth = createAuthFunctions<DataModel, 'owner' | 'viewer'>({
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
	mapRole: (role) => (role === 'owner' || role === 'viewer' ? role : null),
	adminRoles: ['owner'],
})
const authoritySchema = z
	.object({ actor: z.string(), tenant: z.string(), scope: z.string() })
	.strict()
const executionValidator = v.object({
	version: v.literal(1),
	operation: v.string(),
	operationVersion: v.string(),
	contractVersion: v.string(),
	bindingVersion: v.string(),
	run: v.string(),
	capability: v.string(),
	occurrence: v.string(),
	args: v.object({ id: v.id('crudNotes'), title: v.string() }),
})
type Input = { id: Id<'crudNotes'>; title: string }
async function resolve(
	ctx: QueryCtx | MutationCtx,
	execution: WorkflowExecution<Input>,
): Promise<Authority> {
	const issued = await ctx.db
		.query('writes')
		.withIndex('by_key', (q) => q.eq('key', execution.capability))
		.unique()
	if (
		!issued ||
		execution.run !== execution.capability ||
		execution.operation !== 'integratedRename.rename' ||
		execution.occurrence !== 'rename'
	)
		throw new Error('INTEGRATED_RENAME_AUTHORITY')
	const authority = authoritySchema.parse(JSON.parse(issued.stage))
	const permission = await ctx.db
		.query('idempotentPermissions')
		.withIndex('by_scope', (q) => q.eq('scope', authority.scope))
		.unique()
	if (!permission?.allowed) throw new Error('INTEGRATED_RENAME_DENIED')
	return authority
}
function securedHost(ctx: MutationCtx, authority: Authority): Host {
	const rules = composeRules(createTenantRules<DataModel>(authority.tenant, ['crudNotes']), {
		crudNotes: { modify: async (_ctx, row) => row.owner === authority.actor },
		crudAudits: {
			insert: async (_ctx, row) =>
				row.actor === authority.actor && row.operation === 'integratedRename.rename',
		},
		idempotentPermissions: { read: async (_ctx, row) => row.scope === authority.scope },
	})
	return {
		...authority,
		db: wrapDatabaseWriter({}, triggers.wrapDB(ctx).db, rules, { defaultPolicy: 'deny' }),
	}
}
const boundary = effectApiBuilder(internalMutation, {
	services: (ctx) =>
		Context.make(Notes, {
			rename: async (id, title, host) => {
				const nativeId = ctx.db.normalizeId('crudNotes', id)
				if (!nativeId) throw new Error('INTEGRATED_RENAME_ID')
				const row = await host.db.get(nativeId)
				if (!row || row.owner !== host.actor) throw new Error('INTEGRATED_RENAME_MISSING')
				await host.db.patch(nativeId, { title })
			},
		}),
})
// API, selected tool and the actual component step all reach this one native boundary.
export const applyRename = boundary({
	args: { execution: executionValidator },
	returns: v.object({ title: v.string() }),
	handler: (ctx, { execution }) =>
		Effect.promise(() => resolve(ctx, execution)).pipe(
			Effect.flatMap((authority) =>
				commands.exec('rename', execution.args, securedHost(ctx, authority)),
			),
		),
})
async function issue(
	ctx: MutationCtx,
	authority: { actor: { userId: string }; tenant: string; role: string | null },
	input: z.infer<typeof rawInput>,
): Promise<WorkflowExecution<Input>> {
	if (authority.role !== 'owner') throw new Error('INTEGRATED_RENAME_DENIED')
	const scope = JSON.stringify(['integrated-rename', authority.tenant, authority.actor.userId])
	const permission = await ctx.db
		.query('idempotentPermissions')
		.withIndex('by_scope', (q) => q.eq('scope', scope))
		.unique()
	if (permission && !permission.allowed) throw new Error('INTEGRATED_RENAME_DENIED')
	if (!permission) await ctx.db.insert('idempotentPermissions', { scope, allowed: true })
	const id = ctx.db.normalizeId('crudNotes', input.id)
	if (!id) throw new Error('INTEGRATED_RENAME_ID')
	const capability = crypto.randomUUID()
	await ctx.db.insert('writes', {
		key: capability,
		stage: JSON.stringify({ actor: authority.actor.userId, tenant: authority.tenant, scope }),
	})
	return workflowExecution({
		version: 1,
		operation: 'integratedRename.rename',
		operationVersion: '1',
		contractVersion: '1',
		bindingVersion: '1',
		run: capability,
		capability,
		occurrence: 'rename',
		args: { id, title: input.title },
	})
}
export const rename = auth.authMutation({
	args: rawInput.shape,
	returns: result,
	handler: async (ctx, input): Promise<Value> =>
		ctx.runMutation(internal.integratedRename.applyRename, {
			execution: await issue(ctx, ctx, input),
		}),
})
export const invokeTool = action({
	args: {
		id: v.string(),
		title: v.string(),
		tenant: v.optional(v.string()),
		actor: v.optional(v.string()),
	},
	returns: v.union(
		v.object({ _tag: v.literal('Success'), value: v.object({ title: v.string() }) }),
		v.object({ _tag: v.literal('UnknownFailure'), version: v.literal(1) }),
	),
	handler: async (
		ctx,
		input,
	): Promise<{ _tag: 'Success'; value: Value } | { _tag: 'UnknownFailure'; version: 1 }> => {
		const executor = bindOperationExecutor(selectedRename, {
			owner: selectedRename.owner,
			key: selectedRename.key,
			execute: (raw) => ctx.runMutation(api.integratedRename.rename, raw),
		})
		const tools = createOperationTools({
			rename: {
				operation: selectedRename,
				executor,
				description: 'Rename through the same audited native mutation',
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
		return tools.rename.invoke(input)
	},
})
const manager = new WorkflowManager(components.workflow)
export const native = manager.define({
	args: { execution: executionValidator },
	returns: v.object({ title: v.string() }),
	handler: async (step, { execution }): Promise<Value> => {
		await step.awaitEvent({ name: 'continue' })
		return runWorkflowStep(
			step,
			workflowBinding({
				kind: 'mutation',
				operation: 'integratedRename.rename',
				operationVersion: '1',
				contractVersion: '1',
				bindingVersion: '1',
				args: rawInput,
				result,
				reference: internal.integratedRename.applyRename,
			}),
			execution,
			{ inline: true },
		)
	},
})
export const start = auth.authMutation({
	args: rawInput.shape,
	returns: z.string(),
	handler: async (ctx, input): Promise<string> => {
		const execution = await issue(ctx, ctx, input)
		const row = await ctx.db.insert('workflowRuns', {
			key: execution.run,
			state: { generation: 0, status: 'running', nativeStatus: 'running' },
			allowed: true,
			callbackFails: false,
			gate: false,
			attempts: 0,
			bindingVersion: '1',
		})
		const workflowId = await manager.start(
			ctx,
			internal.integratedRename.native,
			{ execution },
			{
				onComplete: internal.integratedRename.complete,
				context: { key: execution.run, generation: 0 },
			},
		)
		await ctx.db.patch(row, { workflowId })
		return execution.run
	},
})
export const complete = internalMutation({
	args: {
		workflowId: vWorkflowId,
		result: vResultValidator,
		context: v.object({ key: v.string(), generation: v.number() }),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query('workflowRuns')
			.withIndex('by_key', (q) => q.eq('key', args.context.key))
			.unique()
		if (
			!row ||
			row.workflowId !== args.workflowId ||
			row.state.generation !== args.context.generation
		)
			return null
		const status = args.result.kind === 'success' ? 'succeeded' : args.result.kind
		await ctx.db.patch(row._id, { state: { ...row.state, status, nativeStatus: status } })
		return null
	},
})
async function run(ctx: QueryCtx | MutationCtx, key: string) {
	const row = await ctx.db
		.query('workflowRuns')
		.withIndex('by_key', (q) => q.eq('key', key))
		.unique()
	if (!row?.workflowId) throw new Error('INTEGRATED_RENAME_RUN_MISSING')
	return { row, workflowId: row.workflowId }
}
export const resume = internalMutation({
	args: { key: v.string() },
	returns: v.null(),
	handler: async (ctx, { key }) => {
		const { workflowId } = await run(ctx, key)
		await manager.sendEvent(ctx, { workflowId, name: 'continue' })
		return null
	},
})
export const inspect = internalQuery({
	args: { key: v.string() },
	returns: v.object({ host: v.string(), native: v.string(), title: v.union(v.string(), v.null()) }),
	handler: async (ctx, { key }) => {
		const { row, workflowId } = await run(ctx, key)
		const status = await manager.status(ctx, workflowId)
		return {
			host: row.state.status,
			native: status.type,
			title: status.type === 'completed' ? result.parse(status.result).title : null,
		}
	},
})
export const setAllowed = internalMutation({
	args: { tenant: v.string(), actor: v.string(), allowed: v.boolean() },
	returns: v.null(),
	handler: async (ctx, input) => {
		const scope = JSON.stringify(['integrated-rename', input.tenant, input.actor])
		const row = await ctx.db
			.query('idempotentPermissions')
			.withIndex('by_scope', (q) => q.eq('scope', scope))
			.unique()
		if (row) await ctx.db.patch(row._id, { allowed: input.allowed })
		else await ctx.db.insert('idempotentPermissions', { scope, allowed: input.allowed })
		return null
	},
})
