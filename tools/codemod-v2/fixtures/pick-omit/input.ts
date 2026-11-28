import { z } from 'zod'

export const Base = z.strictObject({ a: z.string(), b: z.number(), 'c-d': z.boolean() })

export const Picked = Base.pick({ a: true, 'c-d': true })
export const Omitted = Base.omit({ b: true }).optional()
export const Inline = z.strictObject({ x: z.string(), y: z.string() }).pick({ x: true })
