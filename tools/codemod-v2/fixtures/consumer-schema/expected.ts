import { z } from 'zod'
import { os } from '@orpc/server'
import { k } from 'cvx-kit'
export const Part = z.string()
export const Input = z.object({ part: Part })
export const Other = k.string()
os.input(Input)
