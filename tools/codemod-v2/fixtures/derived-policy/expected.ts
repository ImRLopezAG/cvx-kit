import { k } from 'cvx-kit'

const Loose = k.looseObject({ a: k.string(), b: k.string() })
const Strict = k.strictObject({ a: k.string(), b: k.string() })
const Plain = k.object({ a: k.string(), b: k.string() })

export const LoosePick = k.looseObject({ a: k.string() }).pick('a')
export const LooseBound = Loose.omit('b')
export const StrictBound = Strict.partial()
export const PlainBound = Plain.pick('a')

LoosePick.parse({ a: 'x', extra: 1 })
LooseBound.parse({ a: 'x' })
StrictBound.parse({})
PlainBound.parse({ a: 'x' })
