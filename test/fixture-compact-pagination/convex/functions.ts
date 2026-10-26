import { z } from 'zod'
import { createAuthFunctions } from 'cvx-kit/auth'
import {
	query,
	mutation,
	action,
	internalQuery,
	internalMutation,
	internalAction,
} from './_generated/server'
import type { DataModel } from './_generated/dataModel'
import { scalarOptions, relationOptions, idOptions, variantIdOptions } from './tables'

const auth = createAuthFunctions<DataModel, 'reader'>({
	query,
	mutation,
	action,
	internalQuery,
	internalMutation,
	internalAction,
	getAuthUser: async () => {
		console.log('U5_CUSTOMIZATION')
		return { id: 'u5' }
	},
	mapRole: () => {
		console.log('U5_ROLE')
		return 'reader'
	},
	adminRoles: ['reader'],
})
function entered() {
	console.log('U5_HANDLER')
	return 'accepted'
}
// This handler deliberately never enters the query engine.
export const scalar = auth.authQuery({ args: scalarOptions, returns: z.string(), handler: entered })
export const relation = auth.authQuery({
	args: relationOptions,
	returns: z.string(),
	handler: entered,
})
export const idHeavy = auth.authQuery({ args: idOptions, returns: z.string(), handler: entered })
export const variantIds = auth.authQuery({
	args: variantIdOptions,
	returns: z.string(),
	handler: entered,
})
export const mutate = auth.authMutation({ args: idOptions, returns: z.string(), handler: entered })
export const act = auth.authAction({ args: idOptions, returns: z.string(), handler: entered })
export const system = auth.systemQuery({ args: idOptions, returns: z.string(), handler: entered })
export const seed = mutation({
	args: {},
	handler: async (ctx) => {
		const user = await ctx.db.insert('users', { name: 'synthetic-u5' })
		const contact = await ctx.db.insert('contacts', { email: 'synthetic-u5', owner: user })
		return { user, contact }
	},
})
