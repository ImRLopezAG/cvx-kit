import { z } from 'zod'

export const Totals = z.object({
	byStatus: z.record(z.enum(['open', 'closed']), z.number()),
	partial: z.partialRecord(z.enum(['open', 'closed']), z.number()),
	free: z.record(z.string(), z.number()),
})
