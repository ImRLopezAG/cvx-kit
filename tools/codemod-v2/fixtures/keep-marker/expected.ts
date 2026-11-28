// cvx-kit-codemod: keep-zod
import { z } from 'zod'

export const External = z.strictObject({ id: z.string() })
