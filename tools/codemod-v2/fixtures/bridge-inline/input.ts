import { z } from 'zod'
import { zodToConvex } from 'convex-helpers/server/zod4'
export const A = zodToConvex(z.object({ name: z.string() }))
