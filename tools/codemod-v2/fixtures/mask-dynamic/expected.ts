import { k } from 'cvx-kit'

export const Base = k.strictObject({ a: k.string(), b: k.number().finite() })

const mask = { a: true } as const
export const Dynamic = Base.pick('a')
export const Falsy = Base.omit({ a: false })
