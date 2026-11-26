import type { k } from 'cvx-kit'
import { z } from 'zod'

export const S = z.string()
export type S = k.infer<typeof S>
