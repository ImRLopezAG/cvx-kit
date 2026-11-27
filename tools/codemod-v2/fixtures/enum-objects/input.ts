import { z } from 'zod'
export const Status = { A: 'a', B: 'b' } as const
enum Text { A = 'a', B = 'b' }
enum Numeric { A, B }
export const Mixed = { A: 'a', B: 2 }
export const A = z.enum(Status)
export const B = z.enum(Text)
export const C = z.enum(Numeric)
export const D = z.enum(Mixed)
export const E = z.enum(External)
