import { z } from 'zod'
import { k } from 'cvx-kit'
export const Offset = k.isoDateTime()
export const Precision = z.iso.datetime({ precision: 3 })
export const Message = z.iso.date('msg')
