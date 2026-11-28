import { z } from 'zod'
export const ObjectEnum = z.enum({ A: 'a' }, { error: 'use a' })
export const ArrayEnum = z.enum(['a', 'b'], 'msg')
