import { zCustomMutation, zCustomQuery, type ZCustomCtx } from 'convex-helpers/server/zod4'
import { kCustomAction } from 'cvx-kit/registration'
import { action, mutation, query } from './_generated/server'

export const authQuery = zCustomQuery(query, {
	args: {},
	input: async (ctx) => ({ ctx, args: {} }),
})
export const authMutation = zCustomMutation(mutation, {
	args: {},
	input: async (ctx) => ({ ctx, args: {} }),
})
export const authAction = kCustomAction(action, {
	args: {},
	input: async (ctx) => ({ ctx, args: {} }),
})
export type AuthCtx = ZCustomCtx<typeof authQuery>
