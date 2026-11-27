import { z } from 'zod'
import { k } from 'cvx-kit'
export const A = k.string().overwrite(value => value.normalize('NFC'))
export const B = z.string().startsWith('hi')
