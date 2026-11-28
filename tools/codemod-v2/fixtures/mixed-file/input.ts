import { z } from 'zod'

export const Good = z.strictObject({ a: z.string().optional() })

export const Bad = z.tuple([z.string().optional(), z.number()])

export const AlsoGood = z.enum(['x', 'y'])
