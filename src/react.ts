/** Optional React facade. Pure helpers are also available from cvx-kit/errors. */
export { decodeFailure, matchFailure, type FailureHandlers } from './react/failures'
export { useCommand, type Command, type CommandResult } from './react/use-command'
export {
	queryErrors,
	type DecodedFailure,
	type DeclaredFailure,
	type UnknownFailure,
	type ErrorContract,
} from './modules/contracts/errors'
export {
	usePaginatedList,
	type PaginatedList,
	type PaginatedListOptions,
	type ListQueryReference,
} from './react/use-paginated-list'
export {
	defineOptimisticList,
	type OptimisticList,
	type OptimisticListDescriptor,
	type OptimisticInterval,
	type OptimisticOrder,
} from './react/optimistic'
