import { z } from 'zod'

type Sku = string & { readonly __brand: 'sku' }

export const Contact = z.object({
	email: z.email(),
	backup: z.string().trim().email({ message: 'bad mail' }).optional(),
	site: z.url({ protocol: /^https$/, hostname: /\.example\.com$/ }),
	docs: z.string().url('bad url'),
	sku: z.custom<Sku>((value) => String(value).startsWith('SKU-')),
	payload: z.custom<{ id: string }>(),
})

export const Patterned = z.object({ email: z.email({ pattern: /@corp\.test$/ }) })

export const Normalised = z.object({ site: z.url({ normalize: true }) })

export const Uuid = z.object({ id: z.uuid() })

export const Instance = z.object({ at: z.instanceof(Date) })
