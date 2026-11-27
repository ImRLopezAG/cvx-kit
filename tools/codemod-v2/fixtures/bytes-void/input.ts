import { z } from 'zod'
export const Bytes = z.instanceof(ArrayBuffer)
export const Other = z.instanceof(Date)
export const fn = query({ returns: z.void(), handler: () => {} })
export const Field = z.object({ value: z.void() })
