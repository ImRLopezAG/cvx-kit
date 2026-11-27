import { z } from 'zod'
import { k } from 'cvx-kit'

export const Good = k.strictObject({ a: k.string().optional() })

export const Bad = z.tuple([z.string(), z.number()])

export const AlsoGood = k.enum(['x', 'y'])
