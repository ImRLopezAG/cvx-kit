import * as z from 'zod'

export const Spaced = z.strictObject({ n: z.number().min(1) })
