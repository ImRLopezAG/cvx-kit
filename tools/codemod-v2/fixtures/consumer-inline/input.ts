import { z } from 'zod'
import { os } from '@orpc/server'
export const params = z.string()
export const Out = z.string()
export function routes() {
 const procedure = os.$context()
 return procedure.route({}).input(z.object({ params })).output(Out)
}
