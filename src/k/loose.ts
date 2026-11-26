import type { JSONValue, VAny } from 'convex/values'
import { KSchema } from './schema'

/**
 * A plain object whose values are JSON values, with any key Convex accepts in an object value,
 * including `_`-prefixed keys such as `_id` (no leading `$`). Natively `v.any()`: a Convex record (`v.record`) refuses keys
 * starting with `_`, so no typed validator accepts such an object. Parse, and the function boundary,
 * check the whole value.
 */
export class KJsonObject extends KSchema<
	Record<string, JSONValue>,
	VAny<Record<string, JSONValue>>
> {}

const jsonObjectRoot = new KJsonObject(null, 'jsonObject', undefined, undefined)

/** One shared root, as the other argument-less factories: records are immutable. */
export function jsonObject(): KJsonObject {
	return jsonObjectRoot
}
