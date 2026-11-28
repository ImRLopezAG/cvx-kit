import { z } from 'zod'

export const address = z.object({ v4: z.ipv4(), v6: z.ipv6(), token: z.uuid() })
export const formats = z.string().ipv4('address').ipv6().uuid()
export const amount = z.number().gt(1).lt(100).multipleOf(0.05, { error: 'price' })
export const impossible = z.never()
export const pair = z.tuple([z.string(), z.number()])
export const empty = z.tuple([])
export const nested = z.tuple([z.tuple([z.string()])], z.boolean())
export const rest = z.tuple([z.string()]).rest(z.number())
