import { k } from 'cvx-kit'

export const Base = k.strictObject({ a: k.string(), b: k.number().finite(), 'c-d': k.boolean() })

export const Picked = Base.pick('a', 'c-d')
export const Omitted = Base.omit('b').optional()
export const Inline = k.strictObject({ x: k.string(), y: k.string() }).pick('x')
