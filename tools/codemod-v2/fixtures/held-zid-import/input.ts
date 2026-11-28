import { z } from 'zod'
import { zid } from 'cvx-kit/zod-table'
export const Held = z.object({ id: zid('users') }).brand<'Held'>()
