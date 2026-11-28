import { k, type KType } from '../../k'

/**
 * The page result boundary for `dto`. Like v1 it is not strict on parse: Convex may attach engine
 * fields, so unknown keys are stripped; its native validator is the same closed object v1 exported.
 * Building it allocates only `k` records; its native validator is built when Convex first reads it.
 */
export function pageResult<Dto extends KType>(dto: Dto) {
	return k
		.object({
			page: k.array(dto),
			paginationMode: k.literal('native-search').optional(),
			isDone: k.boolean(),
			continueCursor: k.string(),
			splitCursor: k.string().nullable().optional(),
			pageStatus: k.enum(['SplitRecommended', 'SplitRequired']).nullable().optional(),
			completeness: k
				.enum(['complete', 'row-budget', 'byte-budget', 'native-limit', 'result-cap'])
				.optional(),
		})
		.strip()
}
