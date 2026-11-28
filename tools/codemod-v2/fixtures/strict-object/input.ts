import { z } from 'zod'

// Comments survive the rewrite.
export const Input = z.strictObject({
	a: z.string().min(1).optional(), // trailing
	b: z.number().int().max(10).default(3),
})

export const Plain = z.object({ c: z.boolean().nullable() })
