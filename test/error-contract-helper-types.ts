import {
	combineErrorContracts,
	defineErrorContract,
	failureOf,
	isFailure,
	matchFailure,
} from '../src/errors'
import { z } from 'zod'
import type { Command } from '../src/react'
import type { FunctionReference } from 'convex/server'
const a = defineErrorContract({
	SAME: { message: 'Same', details: { value: z.string() } },
	A: { message: 'A', details: {} },
})
const b = defineErrorContract({
	SAME: { message: 'Same', details: { value: z.number() } },
	B: { message: 'B', details: {} },
})
const combined = combineErrorContracts(a, b)
declare const raw: unknown
const result = failureOf(raw, combined, 'SAME', 'A')
if (result?.code === 'SAME') {
	const detail: string | number = result.details.value
	// @ts-expect-error Duplicate details remain a union.
	const wrong: string = result.details.value
	void [detail, wrong]
}
if (isFailure(raw, combined, 'SAME')) {
	// @ts-expect-error Boolean predicate cannot attach a property to an unknown error.
	void raw.failure
}
// @ts-expect-error Unknown codes are rejected.
failureOf(raw, combined, 'FOREIGN')
// @ts-expect-error Unknown codes are rejected by the predicate too.
isFailure(raw, combined, 'FOREIGN')
// @ts-expect-error Combined contracts cannot create ambiguous errors.
combined.create('SAME', { value: 2 })
// @ts-expect-error Constructors preserve code-specific details.
a.envelope('SAME', { value: 2 })
// @ts-expect-error Constructors preserve closed codes.
a.toConvexError('FOREIGN', {})
const envelope = a.envelope('SAME', { value: 'a' })
const exact: 'SAME' = envelope.code
void exact
matchFailure(raw, combined, {
	SAME: ({ details }) => {
		const value: string | number = details.value
		return value
	},
	A: () => 1,
	B: () => 2,
})
// @ts-expect-error Exhaustiveness includes every member code.
matchFailure(raw, combined, { SAME: () => 0, A: () => 1 })
matchFailure(raw, combined, { _: (f) => (f._tag === 'DeclaredFailure' ? f.code : 'unknown') })
declare const command: Command<FunctionReference<'mutation', 'public', {}, number>, typeof combined>
void command
