// cvx-kit-codemod: keep-zod -- the provider SDK validates with Zod
import { z } from 'zod'

export const ProviderPayload = z.object({ id: z.string() })
