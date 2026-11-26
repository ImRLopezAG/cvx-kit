import { k } from 'cvx-kit'

export const Counts = k.object({
	total: k.number().nonnegative(),
	debt: k.number().nonpositive('must not be positive'),
	tags: k.array(k.string()).min(1),
})

export const Flag = k.object({ on: k.boolean() })

export const Positive = k.number().positive()
