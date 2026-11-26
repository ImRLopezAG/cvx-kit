import { z } from 'zod'

export const Range = z
	.object({ from: z.number(), to: z.number() })
	.refine((value) => value.from <= value.to)

export const Clone = Range.extend({})
export const Inline = z
	.object({ a: z.string(), b: z.string() })
	.superRefine(() => {})
	.pick({ a: true })
export const Plain = z.object({ a: z.string() }).extend({ b: z.number() })
export const Field = z.object({ a: z.string().refine((value) => value !== '') }).partial()
