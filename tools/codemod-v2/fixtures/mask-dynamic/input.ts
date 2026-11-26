import { z } from 'zod'

export const Base = z.strictObject({ a: z.string(), b: z.number() })

const mask = { a: true } as const
export const Dynamic = Base.pick(mask)
export const Falsy = Base.omit({ a: false })
