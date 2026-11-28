import { z } from 'zod'

export const Everything = z.strictObject({
	s: z.string().trim().toLowerCase().regex(/^a/).describe('s'),
	n: z.number(),
	i: z.int(),
	big: z.bigint(),
	nil: z.null(),
	lit: z.literal('x'),
	kind: z.enum(['a', 'b']),
	list: z.array(z.string()).length(2),
	either: z.union([z.string(), z.number()]),
	map: z.record(z.string(), z.any()),
	raw: z.unknown(),
	doc: z.json(),
	day: z.iso.date(),
	at: z.iso.datetime(),
	variant: z.discriminatedUnion('type', [
		z.strictObject({ type: z.literal('a') }),
		z.strictObject({ type: z.literal('b') }),
	]),
})

export const Extended = Everything.extend({ more: z.string() }).partial()
export const Upper = z
	.string()
	.toUpperCase()
	.refine((value) => value.length > 0)
export const Piped = z
	.string()
	.transform((value) => value.length)
	.pipe(z.number())
export const Inner = Extended.unwrap
export const parsed = Everything.parse({})
