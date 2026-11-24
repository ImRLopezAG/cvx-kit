import { internalMutationGeneric } from 'convex/server'
import { v } from 'convex/values'
import { defineErrorContract } from '../../src/modules/contracts/errors'

/** Errors the Action registry tests expect to cross the runMutation boundary as declared envelopes. */
export const settlementErrors = defineErrorContract({
	SETTLED: { message: 'Already settled', details: {} },
})

export const record = internalMutationGeneric({
	args: { title: v.string() },
	handler: async (ctx, { title }) => {
		if (title === 'settled') throw settlementErrors.toConvexError('SETTLED', {})
		await ctx.db.insert('documentHistory', { documentTitle: title, actorId: 'action' })
		return title
	},
})
