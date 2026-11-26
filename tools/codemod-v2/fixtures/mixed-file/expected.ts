import { z } from 'zod'
import { k } from 'cvx-kit'

export const Good = k.object({ a: k.string().optional() })

export const Bad = z.tuple([z.string(), z.number()])

export const AlsoGood = k.enum(['x', 'y'])
