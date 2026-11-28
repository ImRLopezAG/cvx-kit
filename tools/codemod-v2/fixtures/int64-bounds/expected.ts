import { z } from 'zod'
import { k } from 'cvx-kit'

export const Bounds = k.int64().min(-5n, 'low').max(10n, { message: 'high' })
export const Inclusive = k.int64().min(1n).max(9n, { message: 'high' })
export const Signs = k.int64().positive('positive').nonnegative().negative({ message: 'negative' }).nonpositive()
export const Greater = z.bigint().gt(2n)
export const Lesser = z.bigint().lt(-2n)
export const Multiple = z.bigint().multipleOf(2n)
export const Zero = k.int64().positive({ message: 'positive' }).negative()
