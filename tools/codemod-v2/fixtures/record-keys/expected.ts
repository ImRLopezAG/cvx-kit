import { k } from 'cvx-kit'

export const Totals = k.object({
	byStatus: k.record(k.enum(['open', 'closed']), k.number()),
	partial: k.partialRecord(k.enum(['open', 'closed']), k.number()),
	free: k.record(k.string(), k.number()),
})
