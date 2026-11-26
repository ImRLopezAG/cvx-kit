import { z } from 'zod'
import { k } from 'cvx-kit'

export const Range = z
	.object({ from: z.number(), to: z.number() })
	.refine((value) => value.from <= value.to)

export const Clone = Range.extend({})
export const Inline = z
	.object({ a: z.string(), b: z.string() })
	.superRefine(() => {})
	.pick({ a: true })
export const Plain = k.object({ a: k.string() }).extend({ b: k.number() })
export const Field = k.object({ a: k.string().refine((value) => value !== '') }).partial()
