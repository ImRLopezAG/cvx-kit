import { k } from 'cvx-kit'

export const address = k.object({ v4: k.ipv4(), v6: k.ipv6(), token: k.uuid() })
export const formats = k.string().ipv4('address').ipv6().uuid()
export const amount = k.number().finite().gt(1).lt(100).multipleOf(0.05, { message: 'price' })
export const impossible = k.never()
export const pair = k.tuple([k.string(), k.number().finite()])
export const empty = k.tuple([])
export const nested = k.tuple([k.tuple([k.string()])], k.boolean())
export const rest = k.tuple([k.string()]).rest(k.number().finite())
