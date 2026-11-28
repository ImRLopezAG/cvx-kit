import { z } from 'zod'
import { k } from 'cvx-kit'

const options = { error: 'shared' }

export const Named = k.string().min(2, { message: 'too short' }).regex(/a/, { message: 'no a' })

export const Account = k
	.object({ a: k.string().optional() })
	.refine((value) => value.a !== undefined, { message: 'needed', path: ['a'] })

export const Referenced = k.string().refine((value) => value.length > 0, options)

export const Mapped = z.string().refine((value) => value.length > 0, { error: () => 'empty' })
