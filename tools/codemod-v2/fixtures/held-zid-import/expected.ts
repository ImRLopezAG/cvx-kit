import { z } from 'zod'
import { zid } from 'convex-helpers/server/zod4'
export const Held = z.object({ id: zid('users') }).brand<'Held'>()
