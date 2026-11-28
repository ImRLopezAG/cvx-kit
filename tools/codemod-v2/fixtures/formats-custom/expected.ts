import { z } from 'zod'
import { k } from 'cvx-kit'

type Sku = string & { readonly __brand: 'sku' }

export const Contact = k.object({
	email: k.email(),
	backup: k.string().trim().email({ message: 'bad mail' }).optional(),
	site: k.url({ protocol: /^https$/, hostname: /\.example\.com$/ }),
	docs: k.string().url('bad url'),
	sku: k.custom<Sku>((value) => String(value).startsWith('SKU-')),
	payload: k.custom<{ id: string }>(),
})

export const Patterned = z.object({ email: z.email({ pattern: /@corp\.test$/ }) })

export const Normalised = z.object({ site: z.url({ normalize: true }) })

export const Uuid = k.object({ id: k.uuid() })

export const Instance = z.object({ at: z.instanceof(Date) })
