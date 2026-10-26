import { useMemo, useState } from 'react'
import { useQueries } from 'convex/react'
import {
	getFunctionName,
	type FunctionArgs,
	type FunctionReference,
	type FunctionReturnType,
	type PaginationOptions,
} from 'convex/server'
import { convexToJson, type Value } from 'convex/values'
import { queryErrors } from '../modules/contracts/errors'
import { decodeFailure, type FailureContract, type FailureOf } from './failures'
import {
	initialPagination,
	reconcilePagination,
	nextPagination,
	paginationView,
	type ListPage,
} from './pagination-state'

export type ListQueryReference = FunctionReference<
	'query',
	'public',
	{ paginationOpts: PaginationOptions },
	ListPage
>
export type PaginatedList<
	Query extends ListQueryReference,
	Contract extends FailureContract = typeof queryErrors,
> = {
	rows: FunctionReturnType<Query>['page']
	isLoading: boolean
	hasNextPage: boolean
	isFetchingNextPage: boolean
	fetchNextPage: () => void
	resetKey: string
	completeness: FunctionReturnType<Query>['completeness'] | undefined
	failure: FailureOf<Contract> | undefined
}
export type PaginatedListOptions<Contract extends FailureContract = typeof queryErrors> = {
	/** Integer 1..100. Initial target for native search; browse uses fixed adjacent pages. */
	pageSize: number
	onInvalidCursor?: 'restart' | 'throw'
	/** Explicit server contract; generated references do not carry error metadata. Defaults to queryErrors. */
	errors?: Contract
	/** Convex value identifying the current auth/scope/reset generation. Never a credential. */
	resetIdentity?: Value
}
type IntervalPagination = {
	numItems: number
	cursor: string | null
	id: number
	endCursor?: string
}
let epoch = 0
/** Reactive engine-backed list: fixed browse ranges or SDK-journal search windows. Empty pages advance manually. */
export function usePaginatedList<
	Query extends ListQueryReference,
	Contract extends FailureContract = typeof queryErrors,
>(
	query: Query,
	args: Omit<FunctionArgs<Query>, 'paginationOpts'> | 'skip',
	options: PaginatedListOptions<Contract>,
): PaginatedList<Query, Contract> {
	const { pageSize } = options
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
		throw new Error('pageSize must be an integer from 1 to 100')
	const skip = args === 'skip'
	// Convex's public encoder sorts object keys recursively and preserves array order, IDs, bytes and int64.
	// SAFETY: FunctionArgs are Convex values; pagination transport is owned exclusively by this hook.
	const effectiveArgs = skip ? {} : (args as Record<string, Value>)
	const identity = JSON.stringify([
		getFunctionName(query),
		convexToJson(effectiveArgs),
		convexToJson(options.resetIdentity ?? null),
		pageSize,
		skip,
	])
	const [stored, setState] = useState(() =>
		initialPagination<FunctionReturnType<Query>>(identity, ++epoch, skip),
	)
	let state = stored
	if (state.identity !== identity) state = initialPagination(identity, ++epoch, skip)
	const queries = useMemo(
		() =>
			Object.fromEntries(
				Object.entries(state.intervals).map(([key, interval]) => {
					const paginationOpts: IntervalPagination = {
						numItems: pageSize,
						cursor: interval.cursor,
						id: state.epoch,
					}
					if (interval.endCursor !== undefined) paginationOpts.endCursor = interval.endCursor
					return [key, { query, args: { ...effectiveArgs, paginationOpts } }]
				}),
			),
		// Equivalent args/references must keep subscriptions stable; identity encodes their effective values.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[state.intervals, state.epoch, identity],
	)
	// SAFETY: useQueries returns each complete endpoint result or an Error for the keyed subscription.
	const results = useQueries(queries) as Record<
		string,
		FunctionReturnType<Query> | Error | undefined
	>
	state = reconcilePagination(state, results)
	const errors = options.errors ?? queryErrors
	let failure = state.error ? decodeFailure(state.error, errors) : undefined
	// Both the explicit decoder and the fixed query contract must validate the actual transported envelope.
	const queryFailure = state.error ? decodeFailure(state.error, queryErrors) : undefined
	const invalid =
		state.error &&
		failure?._tag === 'DeclaredFailure' &&
		failure.code === 'invalid-cursor' &&
		queryFailure?._tag === 'DeclaredFailure' &&
		queryFailure.code === 'invalid-cursor'
	if (invalid && options.onInvalidCursor !== 'throw' && !state.restarted) {
		state = initialPagination(identity, ++epoch, skip, true)
		failure = undefined
	}
	if (state !== stored) setState(state)
	if (invalid && options.onInvalidCursor === 'throw') throw state.error
	const view = paginationView(state)
	const currentEpoch = state.epoch
	return {
		...view,
		// SAFETY: the controller concatenates unmodified elements from this query's validated page DTOs.
		rows: view.rows as FunctionReturnType<Query>['page'],
		completeness: view.completeness,
		// SAFETY: omitted errors selects the default Contract parameter; an explicit contract owns its decoder.
		failure: failure as FailureOf<Contract> | undefined,
		resetKey: `${identity}:${state.restarted ? 1 : 0}`,
		fetchNextPage: () =>
			setState((previous) =>
				previous.epoch === currentEpoch && previous.identity === identity
					? nextPagination(previous)
					: previous,
			),
	}
}
