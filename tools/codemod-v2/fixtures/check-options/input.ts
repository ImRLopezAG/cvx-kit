import { z } from 'zod'

const options = { error: 'shared' }

export const Named = z.string().min(2, { error: 'too short' }).regex(/a/, { message: 'no a' })

export const Account = z
	.object({ a: z.string().optional() })
	.refine((value) => value.a !== undefined, { error: 'needed', path: ['a'] })

export const Referenced = z.string().refine((value) => value.length > 0, options)

export const Mapped = z.string().refine((value) => value.length > 0, { error: () => 'empty' })
