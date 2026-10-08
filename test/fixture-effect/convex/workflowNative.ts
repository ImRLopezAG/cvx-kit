import {
	WorkflowManager,
	vWorkflowId,
	vResultValidator,
	type WorkflowId,
} from '@convex-dev/workflow'
import { ConvexError, v } from 'convex/values'
import { transactionalIdempotency } from 'cvx-kit/idempotency'
import {
	workflowExecution,
	workflowBinding,
	runWorkflowStep,
	workflowAttempt,
	terminalWorkflowAttempt,
	receiptWorkflowMutation,
	workflowReceiptInvocation,
	workflowStatusBindings,
	type WorkflowExecution,
	type WorkflowOutcome,
	type WorkflowNativeStatus,
} from 'cvx-kit/workflow'
import { z } from 'zod'
import { components, internal } from './_generated/api'
import {
	internalMutation,
	internalAction,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from './_generated/server'
import { declaredErrors } from './domain'

// The smoke runner redeploys this marker while a workflow is paused.
export const deployedBindingVersion = '1'
export const deployedArgumentSuffix = ''
const manager = new WorkflowManager(components.workflow, {
	workpoolOptions: {
		retryActionsByDefault: true,
		defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 10, base: 1 },
	},
})
const inputSchema = z.object({ title: z.string() }).strict()
const valueSchema = z.object({ title: z.string() }).strict()
const failureSchema = z.object({ code: z.literal('DENIED'), key: z.string() }).strict()
const outcomeSchema = z.discriminatedUnion('kind', [
	z.object({ version: z.literal(1), kind: z.literal('succeeded'), value: valueSchema }).strict(),
	z.object({ version: z.literal(1), kind: z.literal('failed'), error: failureSchema }).strict(),
])
const hostStateSchema = z
	.object({
		generation: z.number().int().nonnegative(),
		status: z.enum(['running', 'succeeded', 'failed', 'canceled']),
		nativeStatus: z.enum(['running', 'succeeded', 'failed', 'canceled']),
		outcome: outcomeSchema.optional(),
	})
	.strict()
type Input = z.infer<typeof inputSchema>
type Outcome = z.infer<typeof outcomeSchema>
const executionValidator = v.object({
	version: v.literal(1),
	operation: v.string(),
	operationVersion: v.string(),
	contractVersion: v.string(),
	bindingVersion: v.string(),
	run: v.string(),
	capability: v.string(),
	occurrence: v.string(),
	args: v.object({ title: v.string() }),
})
const outcomeValidator = v.union(
	v.object({
		version: v.literal(1),
		kind: v.literal('succeeded'),
		value: v.object({ title: v.string() }),
	}),
	v.object({
		version: v.literal(1),
		kind: v.literal('failed'),
		error: v.object({ code: v.literal('DENIED'), key: v.string() }),
	}),
)
const bounds = {
	maxDepth: 8,
	maxNodes: 100,
	maxBytes: 4096,
	maxArrayLength: 20,
	maxObjectFields: 20,
}
const scope = 'workflow-native-authority'
async function runRow(ctx: QueryCtx | MutationCtx, key: string) {
	const row = await ctx.db
		.query('workflowRuns')
		.withIndex('by_key', (q) => q.eq('key', key))
		.unique()
	if (!row) throw new Error('WORKFLOW_RUN_MISSING')
	return row
}
function workflowIdOf(row: Awaited<ReturnType<typeof runRow>>): WorkflowId {
	if (!row.workflowId) throw new Error('WORKFLOW_RUN_NOT_STARTED')
	return row.workflowId
}
async function authority(ctx: QueryCtx | MutationCtx, execution: WorkflowExecution<Input>) {
	const row = await runRow(ctx, execution.run)
	if (execution.capability !== `host:${row.key}` || !row.allowed)
		throw new ConvexError({ denied: row.key })
	return row
}
function receipt(ctx: MutationCtx, key: string) {
	return transactionalIdempotency({
		final: { replayResult: valueSchema, encode: (value) => value },
		authorize: async () => {
			if (!(await runRow(ctx, key)).allowed) throw new Error('WORKFLOW_RECEIPT_DENIED')
		},
		lookup: (identity) =>
			ctx.db
				.query('idempotentReceipts')
				.withIndex('by_identity', (q) =>
					q.eq('operation', identity.operation).eq('scope', identity.scope).eq('key', identity.key),
				)
				.take(2),
		fingerprint: (canonical) => canonical,
		claim: (identity, retained) =>
			ctx.db.insert('idempotentReceipts', {
				tenant: scope,
				...identity,
				versions: retained.versions,
				fingerprint: retained.fingerprint,
				state: 'pending',
			}),
		complete: (id, retained) => ctx.db.patch(id, { state: 'completed', result: retained.result }),
	})
}
function protectedHandler(ctx?: MutationCtx) {
	const transaction = () => {
		if (!ctx) throw new Error('Receipt handler must execute in its registered mutation')
		return ctx
	}
	return receiptWorkflowMutation({
		authorize: (execution: WorkflowExecution<Input>) => authority(transaction(), execution),
		receipt: (row) => receipt(transaction(), row.key),
		invocation: (execution) =>
			workflowReceiptInvocation(execution, { scope, fingerprintPolicy: 'raw-1', bounds }),
		execute: async (execution) => {
			const key = JSON.stringify([execution.run, execution.occurrence])
			const id = await transaction().db.insert('idempotentNotes', {
				tenant: scope,
				scope,
				key,
				title: execution.args.title,
			})
			await transaction().db.insert('idempotentAudits', {
				tenant: scope,
				scope,
				key,
				id,
				operation: execution.operation,
			})
			return { title: execution.args.title }
		},
	})
}
export const protectedSave = internalMutation({
	args: { execution: executionValidator },
	returns: v.object({ title: v.string() }),
	handler: (ctx, { execution }) => protectedHandler(ctx).handler(execution),
})
export const committedStep = internalMutation({
	args: { execution: executionValidator },
	returns: outcomeValidator,
	handler: (ctx, { execution }) =>
		workflowAttempt({
			authorize: (descriptor: WorkflowExecution<Input>) => authority(ctx, descriptor),
			execute: async (descriptor) => {
				// Invocation-scoped service/authority acquisition is durably counted only on new native calls.
				await ctx.db.insert('writes', {
					key: descriptor.run,
					stage: `service:${descriptor.occurrence}`,
				})
				const value = await protectedHandler(ctx).handler(descriptor)
				return { version: 1 as const, kind: 'succeeded' as const, value }
			},
		})(execution),
})
export const terminalStep = internalMutation({
	args: { execution: executionValidator },
	returns: outcomeValidator,
	handler: (ctx, { execution }) =>
		terminalWorkflowAttempt({
			kind: 'mutation',
			atomicJournalProof: 'host-verified',
			authorize: (descriptor: WorkflowExecution<Input>) => authority(ctx, descriptor),
			invokeMutation: async (descriptor) => {
				await ctx.runMutation(internal.workflowProof.rejectInner, { key: descriptor.run })
				return { title: descriptor.args.title }
			},
			terminal: (error) => {
				if (!(error instanceof ConvexError)) return undefined
				const decoded = declaredErrors.decode(error.data)
				return decoded._tag === 'DeclaredFailure'
					? { code: decoded.code, key: decoded.details.key }
					: undefined
			},
			result: valueSchema,
			failure: failureSchema,
		})(execution),
})
export const authorizeAttempt = internalMutation({
	args: { execution: executionValidator },
	returns: v.number(),
	handler: async (ctx, { execution }) => {
		const row = await authority(ctx, execution)
		await ctx.db.patch(row._id, { attempts: row.attempts + 1 })
		return row.attempts + 1
	},
})
export const transientStep = internalAction({
	args: { execution: executionValidator },
	returns: outcomeValidator,
	handler: async (ctx, { execution }) => {
		await ctx.runMutation(internal.workflowNative.authorizeAttempt, { execution })
		throw new Error('WORKFLOW_TRANSIENT')
	},
})
// The shared factory issues evidence for the same handler registered as protectedSave.
// The action invokes only that registered mutation; it cannot execute the receipt handler locally.
export const postCommitStep = internalAction({
	args: { execution: executionValidator },
	returns: outcomeValidator,
	handler: async (ctx, { execution }): Promise<Outcome> => {
		const attempt = await ctx.runMutation(internal.workflowNative.authorizeAttempt, { execution })
		const protectedMutation = protectedHandler()
		const outcome = await terminalWorkflowAttempt({
			kind: 'action',
			protectedMutation,
			authorize: async () => null,
			invokeMutation: (descriptor) =>
				ctx.runMutation(internal.workflowNative.protectedSave, { execution: descriptor }),
			terminal: () => undefined,
			result: valueSchema,
			failure: failureSchema,
		})(execution)
		// Simulates transport loss after business, audit and receipt commit, before native journal success.
		if (attempt === 1) throw new Error('WORKFLOW_POST_COMMIT_LOST_RESPONSE')
		return outcome
	},
})
export const externalStep = internalAction({
	args: { execution: executionValidator },
	returns: outcomeValidator,
	handler: async (ctx, { execution }): Promise<Outcome> => {
		await ctx.runMutation(internal.workflowNative.authorizeAttempt, { execution })
		// A real running action remains outside mutation rollback and may finish after native cancel.
		for (let i = 0; i < 300; i++) {
			if (
				(await ctx.runQuery(internal.workflowNative.inspectRun, { key: execution.run })).run.gate
			) {
				await ctx.runMutation(internal.workflowNative.externalComplete, { key: execution.run })
				if (execution.run.includes('-external-lost-'))
					throw new Error('WORKFLOW_PROVIDER_RESPONSE_UNKNOWN')
				return { version: 1, kind: 'succeeded', value: execution.args }
			}
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
		throw new Error('WORKFLOW_EXTERNAL_GATE_TIMEOUT')
	},
})
export const externalComplete = internalMutation({
	args: { key: v.string() },
	returns: v.null(),
	handler: async (ctx, { key }) => {
		await ctx.db.insert('writes', { key, stage: 'external-completed' })
		return null
	},
})
function binding(
	reference:
		| typeof internal.workflowNative.committedStep
		| typeof internal.workflowNative.terminalStep,
	version = deployedBindingVersion,
) {
	return workflowBinding({
		kind: 'mutation',
		operation: 'workflow.save',
		operationVersion: '1',
		contractVersion: '1',
		bindingVersion: version,
		compatibleVersions:
			version === 'incompatible'
				? []
				: [{ operationVersion: '1', contractVersion: '1', bindingVersion: '1' }],
		args: inputSchema,
		result: outcomeSchema,
		reference,
	})
}
function actionBinding(
	reference:
		| typeof internal.workflowNative.postCommitStep
		| typeof internal.workflowNative.transientStep
		| typeof internal.workflowNative.externalStep,
) {
	return workflowBinding({
		kind: 'action',
		operation: 'workflow.save',
		operationVersion: '1',
		contractVersion: '1',
		bindingVersion: '1',
		args: inputSchema,
		result: outcomeSchema,
		reference,
	})
}
const modes = v.union(
	v.literal('paused'),
	v.literal('terminal'),
	v.literal('transient'),
	v.literal('postcommit'),
	v.literal('external'),
	v.literal('external-lost'),
	v.literal('loop'),
	v.literal('incompatible'),
)
export const native = manager.define({
	args: { execution: executionValidator, mode: modes, retry: v.boolean() },
	returns: outcomeValidator,
	handler: async (step, args): Promise<Outcome> => {
		const execution = workflowExecution({
			...args.execution,
			args: { title: args.execution.args.title + deployedArgumentSuffix },
		})
		if (args.mode === 'terminal')
			return runWorkflowStep(step, binding(internal.workflowNative.terminalStep), execution, {
				inline: true,
			})
		if (args.mode === 'transient')
			return runWorkflowStep(
				step,
				actionBinding(internal.workflowNative.transientStep),
				execution,
				{ retry: { maxAttempts: 3, initialBackoffMs: 10, base: 1 } },
			)
		if (args.mode === 'postcommit')
			return runWorkflowStep(
				step,
				actionBinding(internal.workflowNative.postCommitStep),
				execution,
				args.retry ? { retry: { maxAttempts: 3, initialBackoffMs: 10, base: 1 } } : {},
			)
		if (args.mode === 'external' || args.mode === 'external-lost')
			return runWorkflowStep(step, actionBinding(internal.workflowNative.externalStep), execution)
		await runWorkflowStep(step, binding(internal.workflowNative.committedStep), execution, {
			inline: true,
		})
		if (args.mode !== 'loop') await step.awaitEvent({ name: 'continue' })
		const second = { ...execution, occurrence: 'second' }
		return runWorkflowStep(
			step,
			binding(
				internal.workflowNative.committedStep,
				args.mode === 'incompatible' ? 'incompatible' : deployedBindingVersion,
			),
			second,
			{ inline: true },
		)
	},
})
function nativeStatus(status: Awaited<ReturnType<typeof manager.status>>): WorkflowNativeStatus {
	return status.type === 'inProgress'
		? 'running'
		: status.type === 'completed'
			? 'succeeded'
			: status.type
}
async function statusBindings(ctx: MutationCtx, key: string) {
	const row = await runRow(ctx, key)
	const workflowId = workflowIdOf(row)
	return workflowStatusBindings({
		authorize: async () => {
			if (!(await runRow(ctx, key)).allowed) throw new Error('WORKFLOW_STATUS_DENIED')
		},
		read: async () => hostStateSchema.parse((await runRow(ctx, key)).state),
		write: async (expected, state) => {
			const current = await runRow(ctx, key)
			if (current.state.generation === expected) await ctx.db.patch(current._id, { state })
		},
		nativeStatus: async () => nativeStatus(await manager.status(ctx, workflowId)),
		receiptOutcome: async (): Promise<
			WorkflowOutcome<z.infer<typeof valueSchema>, z.infer<typeof failureSchema>> | undefined
		> => {
			const native = await manager.status(ctx, workflowId)
			if (native.type === 'completed') return outcomeSchema.parse(native.result)
			const receiptKey = JSON.stringify([key, 'first'])
			const retained = await ctx.db
				.query('idempotentReceipts')
				.withIndex('by_identity', (q) =>
					q.eq('operation', 'workflow.save').eq('scope', scope).eq('key', receiptKey),
				)
				.unique()
			return retained?.state === 'completed'
				? { version: 1, kind: 'succeeded', value: valueSchema.parse(retained.result) }
				: undefined
		},
		cancelNative: () => manager.cancel(ctx, workflowId),
		restartNative: () => manager.restart(ctx, workflowId, { from: 0, startAsync: true }),
	})
}
export const complete = internalMutation({
	args: {
		workflowId: vWorkflowId,
		result: vResultValidator,
		context: v.object({ key: v.string(), generation: v.number() }),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if ((await runRow(ctx, args.context.key)).callbackFails)
			throw new Error('WORKFLOW_CALLBACK_INJECTED')
		const status = args.result.kind === 'success' ? 'succeeded' : args.result.kind
		await (
			await statusBindings(ctx, args.context.key)
		).callback(
			args.context.generation,
			status,
			args.result.kind === 'success' ? outcomeSchema.parse(args.result.returnValue) : undefined,
		)
		return null
	},
})
export const start = internalMutation({
	args: {
		key: v.string(),
		mode: modes,
		retry: v.optional(v.boolean()),
		callbackFails: v.optional(v.boolean()),
	},
	returns: vWorkflowId,
	handler: async (ctx, args): Promise<WorkflowId> => {
		const id = await ctx.db.insert('workflowRuns', {
			key: args.key,
			state: { generation: 0, status: 'running', nativeStatus: 'running' },
			allowed: true,
			callbackFails: args.callbackFails ?? false,
			gate: false,
			attempts: 0,
			bindingVersion: deployedBindingVersion,
		})
		const execution = workflowExecution({
			version: 1,
			operation: 'workflow.save',
			operationVersion: '1',
			contractVersion: '1',
			bindingVersion: '1',
			run: args.key,
			capability: `host:${args.key}`,
			occurrence: 'first',
			args: { title: args.key },
		})
		const workflowId = await manager.start(
			ctx,
			internal.workflowNative.native,
			{ execution, mode: args.mode, retry: args.retry ?? false },
			{
				onComplete: internal.workflowNative.complete,
				context: { key: args.key, generation: 0 },
				startAsync: true,
			},
		)
		await ctx.db.patch(id, { workflowId })
		return workflowId
	},
})
export const control = internalMutation({
	args: {
		key: v.string(),
		operation: v.union(
			v.literal('resume'),
			v.literal('reconcile'),
			v.literal('cancel'),
			v.literal('restart'),
			v.literal('revoke'),
			v.literal('grant'),
			v.literal('release'),
			v.literal('repair'),
		),
		generation: v.optional(v.number()),
	},
	returns: v.any(),
	handler: async (ctx, args) => {
		const row = await runRow(ctx, args.key)
		if (args.operation === 'revoke' || args.operation === 'grant') {
			await ctx.db.patch(row._id, { allowed: args.operation === 'grant' })
			return null
		}
		if (args.operation === 'release') {
			await ctx.db.patch(row._id, { gate: true })
			return null
		}
		if (args.operation === 'repair') {
			await ctx.db.patch(row._id, { callbackFails: false })
			return null
		}
		if (args.operation === 'resume') {
			await manager.sendEvent(ctx, { workflowId: workflowIdOf(row), name: 'continue' })
			return null
		}
		const bindings = await statusBindings(ctx, args.key)
		return bindings[args.operation](args.generation ?? row.state.generation)
	},
})
export const deliverLate = internalMutation({
	args: { key: v.string(), generation: v.number() },
	returns: v.any(),
	handler: async (ctx, args) =>
		(await statusBindings(ctx, args.key)).callback(args.generation, 'succeeded', {
			version: 1,
			kind: 'succeeded',
			value: { title: args.key },
		}),
})
export const inspectRun = internalQuery({
	args: { key: v.string() },
	returns: v.any(),
	handler: async (ctx, { key }) => {
		const run = await runRow(ctx, key)
		const workflowId = workflowIdOf(run)
		const rows = await ctx.db
			.query('writes')
			.withIndex('by_key', (q) => q.eq('key', key))
			.take(30)
		const keys = [JSON.stringify([key, 'first']), JSON.stringify([key, 'second'])]
		const counts = await Promise.all(
			keys.map(async (receiptKey) => ({
				key: receiptKey,
				business: (
					await ctx.db
						.query('idempotentNotes')
						.withIndex('by_scope_key', (q) => q.eq('scope', scope).eq('key', receiptKey))
						.take(5)
				).length,
				audits: (
					await ctx.db
						.query('idempotentAudits')
						.withIndex('by_scope_key', (q) => q.eq('scope', scope).eq('key', receiptKey))
						.take(5)
				).length,
				receipts: await ctx.db
					.query('idempotentReceipts')
					.withIndex('by_identity', (q) =>
						q.eq('operation', 'workflow.save').eq('scope', scope).eq('key', receiptKey),
					)
					.take(5),
			})),
		)
		return {
			run,
			status: await manager.status(ctx, workflowId),
			steps: await manager.listSteps(ctx, workflowId, {
				paginationOpts: { numItems: 20, cursor: null },
			}),
			writes: rows.map((row) => row.stage),
			counts,
		}
	},
})
