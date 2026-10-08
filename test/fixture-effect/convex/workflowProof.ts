import { WorkflowManager, vWorkflowId, type WorkflowId } from '@convex-dev/workflow'
import { ConvexError, v } from 'convex/values'
import { effectApiBuilder } from 'cvx-kit/effect'
import { Context, Effect } from 'effect'
import { components, internal } from './_generated/api'
import { internalMutation, internalQuery } from './_generated/server'
import { commands, declaredErrors } from './domain'

const manager = new WorkflowManager(components.workflow)
const terminalResult = v.object({
	version: v.literal(1),
	code: v.literal('DENIED'),
	key: v.string(),
})
type TerminalResult = { version: 1; code: 'DENIED'; key: string }

const innerMutation = effectApiBuilder(internalMutation, {
	services: () => Context.empty(),
	errors: declaredErrors,
})
export const rejectInner = innerMutation({
	args: { key: v.string() },
	returns: v.literal('saved'),
	handler: (ctx, { key }) =>
		commands
			.exec('save', {}, { ctx, key, mode: 'completion' })
			.pipe(
				Effect.catchTag('FixtureFailure', () =>
					Effect.fail(declaredErrors.create('DENIED', { key })),
				),
			),
})

// This outer native mutation catches only after the inner native call rejects.
// Its normal return is journaled as a successful, safe terminal step value.
export const terminalMutation = internalMutation({
	args: { key: v.string(), rejectOuter: v.boolean() },
	returns: terminalResult,
	handler: async (ctx, args): Promise<TerminalResult> => {
		try {
			await ctx.runMutation(internal.workflowProof.rejectInner, {
				key: args.key,
			})
		} catch (error) {
			if (!(error instanceof ConvexError)) throw error
			const failure = declaredErrors.decode(error.data)
			if (failure._tag !== 'DeclaredFailure') throw error
			await ctx.db.insert('writes', { key: args.key, stage: 'outer-terminal' })
			if (args.rejectOuter) throw new Error('WORKFLOW_OUTER_ROLLBACK')
			return { version: 1, code: failure.code, key: failure.details.key }
		}
		throw new Error('Expected rejected inner mutation')
	},
})

export const proof = manager.define({
	args: { key: v.string(), rejectOuter: v.boolean() },
	returns: terminalResult,
	handler: async (step, args): Promise<TerminalResult> =>
		step.runMutation(internal.workflowProof.terminalMutation, args, {
			inline: true,
			name: 'terminal-native-subtransaction',
		}),
})

export const start = internalMutation({
	args: { key: v.string(), rejectOuter: v.boolean() },
	returns: vWorkflowId,
	handler: (ctx, args): Promise<WorkflowId> =>
		manager.start(ctx, internal.workflowProof.proof, args),
})

export const inspect = internalQuery({
	args: { workflowId: vWorkflowId, key: v.string() },
	returns: v.object({ status: v.any(), steps: v.any(), writes: v.array(v.string()) }),
	handler: async (ctx, args) => ({
		status: await manager.status(ctx, args.workflowId),
		steps: await manager.listSteps(ctx, args.workflowId, {
			paginationOpts: { numItems: 10, cursor: null },
		}),
		writes: (
			await ctx.db
				.query('writes')
				.withIndex('by_key', (q) => q.eq('key', args.key))
				.take(10)
		).map((row) => row.stage),
	}),
})
