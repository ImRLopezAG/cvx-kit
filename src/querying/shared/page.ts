import { z } from 'zod'

/** Construct only the result boundary when native pagination arguments are unused.
 * Given a builder, the row validator builds on the first read of `page` (parse,
 * Convex export or a shape read), once: zod mirrors the getter through
 * `.extend`/`.pick` and every copy shares the one array schema. */
export function pageResult<Dto extends z.ZodType>(dto: Dto | (() => Dto)) {
	let page: z.ZodArray<Dto> | undefined
	const array = dto instanceof z.ZodType ? z.array(dto) : undefined
	return z.object({
		get page(): z.ZodArray<Dto> {
			// SAFETY: a non-schema argument is the memoized row builder.
			return array ?? (page ??= z.array((dto as () => Dto)()))
		},
		paginationMode: z.literal('native-search').optional(),
		isDone: z.boolean(),
		continueCursor: z.string(),
		splitCursor: z.string().nullable().optional(),
		pageStatus: z.enum(['SplitRecommended', 'SplitRequired']).nullable().optional(),
		completeness: z
			.enum(['complete', 'row-budget', 'byte-budget', 'native-limit', 'result-cap'])
			.optional(),
	})
}
