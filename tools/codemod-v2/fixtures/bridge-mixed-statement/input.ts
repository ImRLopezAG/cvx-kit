import { z } from 'zod'
import { zodToConvex } from 'convex-helpers/server/zod4'
export const Schema = z.string()
export const A = zodToConvex(Schema), B = zodToConvex(External)
