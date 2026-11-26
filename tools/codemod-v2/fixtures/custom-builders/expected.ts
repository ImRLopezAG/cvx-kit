import { kCustomAction, kCustomMutation, kCustomQuery, type KCustomCtx } from 'cvx-kit/registration'
import { action, mutation, query } from './_generated/server'

export const authQuery = kCustomQuery(query, {
	args: {},
	input: async (ctx) => ({ ctx, args: {} }),
})
export const authMutation = kCustomMutation(mutation, {
	args: {},
	input: async (ctx) => ({ ctx, args: {} }),
})
export const authAction = kCustomAction(action, {
	args: {},
	input: async (ctx) => ({ ctx, args: {} }),
})
export type AuthCtx = KCustomCtx<typeof authQuery>
