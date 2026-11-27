import { z } from 'zod'
export const Base = z.object({ a: z.string(), b: z.string() })
export const A = Base.partial({ a: true })
export const B = Base.required({ b: true })
