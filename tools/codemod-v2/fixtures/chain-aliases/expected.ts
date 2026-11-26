import { z } from 'zod'
import { k } from 'cvx-kit'

export const Counts = k.object({
	total: k.number().min(0),
	debt: k.number().max(0, 'must not be positive'),
	tags: k.array(k.string()).min(1),
})

export const Flag = k.object({ on: k.boolean() })

export const Positive = z.number().positive()
