import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
	writes: defineTable({ key: v.string(), stage: v.string() }).index('by_key', ['key']),
})
