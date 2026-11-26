import { k } from 'cvx-kit/k'
import { z } from 'zod'

export const Done = k.string()

export const Left = z.string().min(1).max(5)
