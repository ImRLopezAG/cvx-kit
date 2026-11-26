import { z } from 'zod'
import { k } from 'cvx-kit'

export const Event = k.looseObject({ id: k.string(), type: k.string() })
export const Passthrough = k.object({ id: k.string() }).loose()
export const Loose = k.object({ id: k.string() }).loose()
export const Catchall = z.object({ id: z.string() }).catchall(z.number())

export const read = Event.parse({ id: 'evt', type: 'charge', livemode: true })
