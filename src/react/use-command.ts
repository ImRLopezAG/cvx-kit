import { useCallback, useMemo, useRef, useState } from 'react'
import { useMutation } from 'convex/react'
import type { OptimisticUpdate } from 'convex/browser'
import type {
	FunctionArgs,
	FunctionReference,
	FunctionReturnType,
	OptionalRestArgs,
} from 'convex/server'
import { decodeFailure, type FailureContract, type FailureOf } from './failures'

export type CommandResult<Result, Contract extends FailureContract> =
	| Readonly<{ ok: true; value: Result }>
	| Readonly<{ ok: false; failure: FailureOf<Contract> }>
export type Command<
	Mutation extends FunctionReference<'mutation'>,
	Contract extends FailureContract,
> = ((
	...args: OptionalRestArgs<Mutation>
) => Promise<CommandResult<FunctionReturnType<Mutation>, Contract>>) & {
	readonly isPending: boolean
	/** The latest invocation's settled result; older concurrent completions cannot overwrite it. */
	readonly result: CommandResult<FunctionReturnType<Mutation>, Contract> | undefined
}

/** Explicit failures plus Convex-owned optimistic execution, replay and rollback. */
export function useCommand<
	Mutation extends FunctionReference<'mutation'>,
	Contract extends FailureContract,
	Update extends OptimisticUpdate<FunctionArgs<Mutation>> = OptimisticUpdate<
		FunctionArgs<Mutation>
	>,
>(
	reference: Mutation,
	options: {
		errors: Contract
		optimisticUpdate?: Update &
			(ReturnType<Update> extends Promise<any>
				? 'Optimistic update handlers must be synchronous'
				: {})
	},
): Command<Mutation, Contract> {
	const mutation = useMutation(reference)
	const { errors, optimisticUpdate } = options
	// Attach once per mutation/callback identity. Convex may invoke this callback repeatedly while pending.
	const run = useMemo(
		() => (optimisticUpdate ? mutation.withOptimisticUpdate<Update>(optimisticUpdate) : mutation),
		[mutation, optimisticUpdate],
	)
	const [pending, setPending] = useState(0)
	const [result, setResult] = useState<CommandResult<FunctionReturnType<Mutation>, Contract>>()
	const latest = useRef(0)
	const execute = useCallback(
		async (...args: OptionalRestArgs<Mutation>) => {
			const invocation = ++latest.current
			setPending((count) => count + 1)
			let settled: CommandResult<FunctionReturnType<Mutation>, Contract>
			try {
				settled = { ok: true, value: await run(...args) }
			} catch (error) {
				settled = { ok: false, failure: decodeFailure(error, errors) }
			}
			setPending((count) => count - 1)
			if (latest.current === invocation) setResult(settled)
			return settled
		},
		[run, errors],
	)
	return useMemo(
		() =>
			Object.assign((...args: OptionalRestArgs<Mutation>) => execute(...args), {
				isPending: pending > 0,
				result,
			}),
		[execute, pending, result],
	)
}
