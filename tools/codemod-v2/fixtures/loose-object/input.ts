import { z } from 'zod'

export const Event = z.looseObject({ id: z.string(), type: z.string() })
export const Passthrough = z.object({ id: z.string() }).passthrough()
export const Loose = z.object({ id: z.string() }).loose()
export const Catchall = z.object({ id: z.string() }).catchall(z.number())

export const read = Event.parse({ id: 'evt', type: 'charge', livemode: true })
