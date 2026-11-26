import { k } from 'cvx-kit'

export const Everything = k.object({
	s: k.string().trim().toLowerCase().regex(/^a/).describe('s'),
	n: k.number().finite(),
	i: k.int().safe(),
	big: k.int64(),
	nil: k.null(),
	lit: k.literal('x'),
	kind: k.enum(['a', 'b']),
	list: k.array(k.string()).length(2),
	either: k.union([k.string(), k.number().finite()]),
	map: k.record(k.string(), k.any()),
	raw: k.any(),
	doc: k.json(),
	day: k.isoDate(),
	at: k.isoDateTime(),
	variant: k.discriminatedUnion('type', [
		k.object({ type: k.literal('a') }),
		k.object({ type: k.literal('b') }),
	]),
})

export const Extended = Everything.extend({ more: k.string() }).partial()
export const Upper = k
	.string()
	.toUpperCase()
	.refine((value) => value.length > 0)
export const Piped = k
	.string()
	.transform((value) => value.length)
	.pipe(k.number().finite())
export const Inner = Extended.unwrap
export const parsed = Everything.parse({})
