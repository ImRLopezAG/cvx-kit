import { z } from 'zod'
import { k } from 'cvx-kit'
export const Status = { A: 'a', B: 'b' } as const
enum Text { A = 'a', B = 'b' }
enum Numeric { A, B }
export const Mixed = { A: 'a', B: 2 }
export const A = k.enum(Status)
export const B = k.enum(Text)
export const C = z.enum(Numeric)
export const D = z.enum(Mixed)
export const E = z.enum(External)
