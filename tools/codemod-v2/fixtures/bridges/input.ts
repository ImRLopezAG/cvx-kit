import { z } from 'zod'
import { zodToConvex, convexToZod } from 'convex-helpers/server/zod4'
export const Schema = z.string()
export const A = zodToConvex(Schema)
export const B = zodToConvex(External)
export const C = convexToZod(v.string())
