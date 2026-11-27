import { z } from 'zod'
import { os } from '@orpc/server'
export const Part = z.string()
export const Input = z.object({ part: Part })
export const Other = z.string()
os.input(Input)
