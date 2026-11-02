import { z } from 'zod'

/** Construct only the result boundary when native pagination arguments are unused. */
export function pageResult<Dto extends z.ZodType>(dto: Dto) {
	return z.object({
		page: z.array(dto),
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
