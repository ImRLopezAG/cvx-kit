import { useCommand, decodeFailure, matchFailure } from '../../src/react'
import { z } from 'zod'
import { defineErrorContract } from '../../src/errors'
import type { FunctionReference } from 'convex/server'
import type { OptimisticLocalStore } from 'convex/browser'
const errors = defineErrorContract({
	CONFLICT: {
		message: 'Changed',
		details: { revision: z.number() },
	},
	FORBIDDEN: { message: 'Forbidden', details: {} },
})
const underscore = defineErrorContract({
	_: { message: 'Underscore', details: { id: z.string() } },
})
type UnderscoreFailure = Extract<ReturnType<typeof underscore.decode>, { _tag: 'DeclaredFailure' }>
// @ts-expect-error The fallback must accept UnknownFailure even when '_' is a declared code.
matchFailure(new Error(), underscore, { _: (failure: UnderscoreFailure) => failure.details.id })
matchFailure(new Error(), underscore, {
	_: (failure) => (failure._tag === 'DeclaredFailure' ? failure.details.id : 'unknown'),
})
type Mutation = FunctionReference<'mutation', 'public', { id: string }, { saved: boolean }>
type Refresh = FunctionReference<'mutation', 'public', {}, number>
export function Probe({ mutation, noArgs }: { mutation: Mutation; noArgs: Refresh }) {
	const save = useCommand(mutation, {
		errors,
		optimisticUpdate: (_store: OptimisticLocalStore, args) => {
			const id: string = args.id
			void id
		},
	})
	const pending: boolean = save.isPending
	const result = save.result
	if (result?.ok) {
		const saved: boolean = result.value.saved
		void saved
	} else if (
		result &&
		result.failure._tag === 'DeclaredFailure' &&
		result.failure.code === 'CONFLICT'
	) {
		const revision: number = result.failure.details.revision
		void revision
		// @ts-expect-error Details are precise rather than any.
		const wrong: string = result.failure.details.revision
		void wrong
	}
	void save({ id: 'one' }).then((result) => {
		if (result.ok) {
			const saved: boolean = result.value.saved
			void saved
		} else if (result.failure._tag === 'DeclaredFailure' && result.failure.code === 'CONFLICT') {
			const revision: number = result.failure.details.revision
			void revision
		}
	})
	// @ts-expect-error Mutation arguments stay precise.
	void save({ id: 1 })
	// @ts-expect-error Required args cannot be omitted.
	void save()
	// @ts-expect-error Error contracts are explicit.
	useCommand(mutation)
	// @ts-expect-error Convex optimistic callbacks must be synchronous.
	useCommand(mutation, { errors, optimisticUpdate: async () => {} })
	const refresh = useCommand(noArgs, { errors })
	void refresh()
	const matched = matchFailure(new Error(), errors, {
		CONFLICT: ({ details }) => details.revision,
		FORBIDDEN: () => 'forbidden',
		_: () => false,
	})
	const typed: number | string | boolean = matched
	// @ts-expect-error Match results retain the handler return union.
	const wrongResult: Date = matched
	void [pending, typed, wrongResult, decodeFailure(new Error(), errors)]
	return null
}
