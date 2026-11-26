import { z } from 'zod'
import { Remote } from './still-zod'
import { k } from 'cvx-kit'

export const Local = k.object({ a: k.string() })
export type Local = k.infer<typeof Local>
export type Remote = z.infer<typeof Remote>
export type LocalIn = k.input<typeof Local>
