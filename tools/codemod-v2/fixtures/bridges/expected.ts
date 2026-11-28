import { k } from 'cvx-kit'
import { zodToConvex, convexToZod } from 'convex-helpers/server/zod4'
export const Schema = k.string()
export const A = Schema.validator
export const B = zodToConvex(External)
export const C = convexToZod(v.string())
