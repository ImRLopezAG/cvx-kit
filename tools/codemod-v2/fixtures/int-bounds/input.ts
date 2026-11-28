import { z } from 'zod'

const n = z.number()
export const Count = n.int()
export const Message = z.number().int({ error: 'bad' })
export const Optional = z.number().int().optional()
export const InUnion = z.union([z.number(), z.string()])
export const Coerced = z.coerce.number()
export const Int32 = z.int32()
const Parsed = z.string().transform(Number).pipe(z.number())
export const Unproven = Parsed.int()
