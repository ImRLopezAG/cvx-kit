import { internalMutationGeneric } from 'convex/server'
import { ConvexError, v } from 'convex/values'

export const record = internalMutationGeneric({
	args: { title: v.string() },
	handler: async (ctx, { title }) => {
		// The declared envelope the Action tests' settlement contract decodes.
		if (title === 'settled')
			throw new ConvexError({
				_tag: 'DeclaredFailure',
				version: 1,
				code: 'SETTLED',
				message: 'Already settled',
				details: {},
			})
		await ctx.db.insert('documentHistory', { documentTitle: title, actorId: 'action' })
		return title
	},
})
