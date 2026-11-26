import { z } from 'zod'
import { zid } from 'convex-helpers/server/zod4'
import { zodContract } from 'cvx-kit/contracts'
import { effectZodApiBuilder } from 'cvx-kit/effect'

export const Ref = z.strictObject({ user: zid('users'), team: zid('teams').optional() })

export const contract = zodContract(Ref)

export const api = effectZodApiBuilder({ input: Ref })
