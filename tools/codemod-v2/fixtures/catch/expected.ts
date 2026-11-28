import { z } from 'zod'
import { k } from 'cvx-kit'

export const Role = k.enum(['admin', 'member']).catch('member')
export const Claims = k.object({
	org: k.string().optional().catch(undefined),
	roles: k.array(k.string()).catch(() => []),
	level: k.number().finite().catch(({ input }) => Number(input)),
})
export const Legacy = z.string().catch((ctx) => String(ctx.error))
