import { z } from 'zod'
import { k } from 'cvx-kit'

const n = k.number().finite()
export const Count = n.int()
export const Message = k.number().int({ message: 'bad' })
export const Optional = k.int().optional()
export const InUnion = k.union([k.number().finite(), k.string()])
export const Coerced = z.coerce.number()
export const Int32 = z.int32()
const Parsed = k.string().transform(Number).pipe(k.number().finite())
export const Unproven = Parsed.int()
