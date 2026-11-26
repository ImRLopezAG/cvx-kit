import { z } from 'zod'

export const Amount = z.object({
	cents: z.number().int().positive(),
	balance: z.number().nonnegative(),
	debt: z.number().negative().nonpositive(),
	rate: z.number().finite(),
	big: z.number().safe(),
})

export const Range = z.object({ from: z.number(), to: z.number() }).check((value, ctx) => {
	if (value.from > value.to) ctx.addIssue({ message: 'to must be >= from' })
})

export const ZodForm = z.string().check((ctx) => {
	if (ctx.value.length === 0)
		ctx.issues.push({ code: 'custom', message: 'empty', input: ctx.value })
})
