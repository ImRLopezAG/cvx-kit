import { v } from 'convex/values'
import { createEffectFoundation, effectApiBuilder } from 'cvx-kit/effect'
import { k } from 'cvx-kit/k'
import { Context, Effect } from 'effect'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { action, internalMutation, internalQuery } from './_generated/server'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'

const probeIdentity = k
	.object({
		role: k.literal('owner'),
		org_id: k.string(),
		subject: k.string(),
	})
	.strip()
async function scopedProbeKey(ctx: MutationCtx | QueryCtx, key: string): Promise<string> {
	const identity = probeIdentity.safeParse(await ctx.auth.getUserIdentity())
	if (!identity.success) throw new Error('ACTION_VALIDATION_OWNER_REQUIRED')
	return JSON.stringify([
		'native-action-validation',
		identity.data.org_id,
		identity.data.subject,
		key,
	])
}

// This mutation accepts no ID: a nested ID validator cannot mask action registration failure.
export const recordExecution = internalMutation({
	args: { key: v.string() },
	returns: v.null(),
	handler: async (ctx, { key }) => {
		await ctx.db.insert('writes', { key: await scopedProbeKey(ctx, key), stage: 'domain' })
		return null
	},
})

export const proof = internalQuery({
	args: { key: v.string() },
	returns: v.array(v.string()),
	handler: async (ctx, { key }) => {
		const scopedKey = await scopedProbeKey(ctx, key)
		return (
			await ctx.db
				.query('writes')
				.withIndex('by_key', (q) => q.eq('key', scopedKey))
				.take(20)
		).map((row) => row.stage)
	},
})

type Host = { ctx: ActionCtx; id: Id<'crudNotes'> }
const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'ACTION_VALIDATION_FAILURE' }),
	},
	writeAudit: () => undefined,
})
const operations = foundation.Query({
	context: (host: Host) => host,
	operations: ({ query }) => ({
		readNote: query({
			input: k.object({ key: k.string() }),
			result: k.object({ title: k.string() }),
			handler: async ({ key }, host) => {
				// Commit before the secured read, so even a later nested rejection leaves evidence.
				await host.ctx.runMutation(internal.actionValidation.recordExecution, { key })
				const note = await host.ctx.runQuery(api.crud.get, { id: host.id })
				if (!note) throw new Error('ACTION_VALIDATION_NOTE_MISSING')
				return { title: note.title }
			},
		}),
	}),
})

const nativeAction = effectApiBuilder(action, { services: () => Context.empty() })
export const readNote = nativeAction({
	args: { id: v.id('crudNotes'), key: v.string() },
	returns: v.object({ title: v.string() }),
	handler: (ctx, args): Effect.Effect<{ title: string }, unknown> =>
		operations.exec('readNote', { key: args.key }, { ctx, id: args.id }),
})
