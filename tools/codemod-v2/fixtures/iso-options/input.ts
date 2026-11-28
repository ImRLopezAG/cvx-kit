import { z } from 'zod'
export const Offset = z.iso.datetime({ offset: true })
export const Precision = z.iso.datetime({ precision: 3 })
export const Message = z.iso.date('msg')
