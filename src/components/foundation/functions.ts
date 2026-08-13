import { v } from 'convex/values'

import { query } from './_generated/server'

/** Minimal health signal exposed only through the configured host facade. */
export const status = query({
	args: {},
	returns: v.literal('ready'),
	handler: async () => 'ready' as const,
})
