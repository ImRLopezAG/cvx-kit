import { z } from 'zod'

export const Counts = z.strictObject({
	total: z.number().nonnegative(),
	debt: z.number().nonpositive('must not be positive'),
	tags: z.array(z.string()).nonempty(),
})

export const Flag = z.object({ on: z.boolean() }).strict()

export const Positive = z.number().positive()
