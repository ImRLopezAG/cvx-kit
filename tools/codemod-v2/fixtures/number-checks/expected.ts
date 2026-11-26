import { z } from 'zod'
import { k } from 'cvx-kit'

export const Amount = k.object({
	cents: k.number().int().positive(),
	balance: k.number().nonnegative(),
	debt: k.number().negative().nonpositive(),
	rate: k.number().finite(),
	big: k.number().safe(),
})

export const Range = k.object({ from: k.number(), to: k.number() }).check((value, ctx) => {
	if (value.from > value.to) ctx.addIssue({ message: 'to must be >= from' })
})

export const ZodForm = z.string().check((ctx) => {
	if (ctx.value.length === 0)
		ctx.issues.push({ code: 'custom', message: 'empty', input: ctx.value })
})
