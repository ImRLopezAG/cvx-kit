import { z } from 'zod'

const Loose = z.looseObject({ a: z.string(), b: z.string() })
const Strict = z.strictObject({ a: z.string(), b: z.string() })
const Plain = z.object({ a: z.string(), b: z.string() })

export const LoosePick = z.looseObject({ a: z.string() }).pick({ a: true })
export const LooseBound = Loose.omit({ b: true })
export const StrictBound = Strict.partial()
export const PlainBound = Plain.pick({ a: true })

LoosePick.parse({ a: 'x', extra: 1 })
LooseBound.parse({ a: 'x' })
StrictBound.parse({})
PlainBound.parse({ a: 'x' })
