import type { JSONValue, VAny } from 'convex/values'
import { KAny } from './kinds'
import type { KSchema } from './schema'

// A plain object of JSON values with any Convex object keys (`_id` too); natively `v.any()`.
export type KJsonObject = KSchema<Record<string, JSONValue>, VAny<Record<string, JSONValue>>>

// SAFETY: the jsonObject root parses to a plain object of JSON values; KAny only lends its runtime class.
const jsonObjectRoot = new KAny(null, 'jsonObject', undefined, undefined) as KJsonObject

export function jsonObject(): KJsonObject {
	return jsonObjectRoot
}
