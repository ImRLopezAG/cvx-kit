import { k } from 'cvx-kit'

// Comments survive the rewrite.
export const Input = k.object({
	a: k.string().min(1).optional(), // trailing
	b: k.number().int().max(10).default(3),
})

export const Plain = k.object({ c: k.boolean().nullable() })
