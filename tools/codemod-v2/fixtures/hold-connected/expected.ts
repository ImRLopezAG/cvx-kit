import { z } from 'zod'
import { k } from 'cvx-kit'
export const A = z.string()
export const B = z.object({ a: A }).brand<'B'>()
export const C = B.optional()
export const Free = k.string()
