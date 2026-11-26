import { z } from 'zod'
import { k } from 'cvx-kit'

const n = k.number().finite()
export const Count = n.int().safe()
export const Message = k.number().int({ message: 'bad' }).safe()
export const Optional = k.int().safe().optional()
export const InUnion = k.union([k.number().finite(), k.string()])
export const Coerced = z.coerce.number()
export const Int32 = z.int32()
const Parsed = z.string().transform(Number).pipe(z.number())
export const Unproven = Parsed.int()
