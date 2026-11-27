import { k } from 'cvx-kit'

export const Counts = k.strictObject({
	total: k.number().finite().nonnegative(),
	debt: k.number().finite().nonpositive('must not be positive'),
	tags: k.array(k.string()).min(1),
})

export const Flag = k.object({ on: k.boolean() }).strict()

export const Positive = k.number().finite().positive()
