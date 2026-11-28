import { z } from 'zod'; import { queryGeneric as query } from 'convex/server'
import { k } from 'cvx-kit';
export const Bytes = k.bytes()
export const Other = z.instanceof(Date)
export const fn = query({ get returns() { return k.void() }, handler: () => {} })
export const Field = z.object({ value: z.void() })
