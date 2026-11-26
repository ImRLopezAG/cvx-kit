import { z } from 'zod'
import { Remote } from './still-zod'

export const Local = z.object({ a: z.string() })
export type Local = z.infer<typeof Local>
export type Remote = z.infer<typeof Remote>
export type LocalIn = z.input<typeof Local>
