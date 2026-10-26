import { v } from 'convex/values'
import { defineFilterContract } from '../../src/filters'
export const filters = defineFilterContract({
	status: v.union(v.literal('open'), v.literal('done')),
	title: v.string(),
	score: v.number(),
	count: v.optional(v.int64()),
	active: v.boolean(),
	nullable: v.union(v.string(), v.null()),
	reference: v.id('targets'),
})
export const encoded = filters.searchParam.encode({
	status: { in: ['open', 'done'] },
	count: { gte: 1n },
})
