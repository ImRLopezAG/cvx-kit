import { parseSchema } from '../../k/parse'
import type { KType } from '../../k/types'

/** Strictly decodes a component result; an id brand describes its component contract. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Component results are undecoded values at the host boundary.
export function componentResult<S extends KType>(schema: S): (value: unknown) => S['_output'] {
	// SAFETY: the strict parser checks the complete schema and returns its declared output.
	return (value) => parseSchema(schema, value, false) as S['_output']
}
