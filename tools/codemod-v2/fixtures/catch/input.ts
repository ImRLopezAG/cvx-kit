import { z } from 'zod'

export const Role = z.enum(['admin', 'member']).catch('member')
export const Claims = z.object({
	org: z.string().optional().catch(undefined),
	roles: z.array(z.string()).catch(() => []),
	level: z.number().catch(({ input }) => Number(input)),
})
export const Legacy = z.string().catch((ctx) => String(ctx.error))
