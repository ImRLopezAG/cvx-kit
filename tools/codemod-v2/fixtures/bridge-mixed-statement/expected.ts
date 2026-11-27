import { k } from 'cvx-kit'
import { zodToConvex } from 'convex-helpers/server/zod4'
export const Schema = k.string()
export const A = Schema.validator, B = zodToConvex(External)
