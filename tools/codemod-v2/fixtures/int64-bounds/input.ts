import { z } from 'zod'

export const Bounds = z.bigint().min(-5n, 'low').max(10n, { error: 'high' })
export const Inclusive = z.bigint().gte(1n).lte(9n, { message: 'high' })
export const Signs = z.bigint().positive('positive').nonnegative().negative({ error: 'negative' }).nonpositive()
export const Greater = z.bigint().gt(2n)
export const Lesser = z.bigint().lt(-2n)
export const Multiple = z.bigint().multipleOf(2n)
export const Zero = z.bigint().gt(0n, { error: 'positive' }).lt(0n)
