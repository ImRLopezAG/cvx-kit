import { NoOp } from 'convex-helpers/server/customFunctions'
import {
	actionGeneric,
	defineSchema,
	internalActionGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	type DefaultFunctionArgs,
	type GenericDataModel,
	type GenericQueryCtx,
} from 'convex/server'
import { ConvexError, type Value } from 'convex/values'
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import {
	ARGUMENT_ISSUE_LIMITS,
	argumentErrors,
	combineErrorContracts,
	decodeFailure,
	defineErrorContract,
	failureOf,
	matchFailure,
	sanitizeArgumentIssues,
	type ArgumentFailure,
} from '../src/errors'
import { createAuthReaders } from '../src/auth'
import { zCustomFunctions, zCustomQuery } from '../src/zod-registration'
import {
	relationFilterSchema,
	scalarPredicateFromSchema,
	type FilterGrammar,
} from '../src/querying/shared/filters'

const schema = defineSchema({})
const harness = () =>
	convexTest(schema, { './_generated/server.ts': async () => ({ query: queryGeneric }) })

type Runtime = {
	_handler(ctx: GenericQueryCtx<GenericDataModel>, args: DefaultFunctionArgs): Promise<Value>
}
function runtime(fn: { isConvexFunction: true }): Runtime {
	// SAFETY: native generated builders attach this runtime method; the test boundary permits invalid input.
	return fn as typeof fn & Runtime
}
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Rejections are untrusted until asserted.
function dataOf(error: unknown): Value {
	expect(error).toBeInstanceOf(ConvexError)
	// SAFETY: asserted to be a ConvexError just above.
	return (error as ConvexError<Value>).data
}
/* oxlint-disable anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters -- Rejections are compared, not consumed. */
async function rejection(
	fn: { isConvexFunction: true },
	args: DefaultFunctionArgs,
): Promise<unknown> {
	return harness()
		.run((ctx) => runtime(fn)._handler(ctx, args))
		.then(
			() => Error('expected rejection'),
			(error: unknown) => error,
		)
}
/* oxlint-enable anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters */

function compactArgs() {
	const grammar: FilterGrammar = {
		fields: { value: scalarPredicateFromSchema(z.string(), true, false).optional() },
		relations: {},
	}
	return { filters: relationFilterSchema(grammar, undefined, { validator: 'compact' }) }
}
// oxlint-disable-next-line anti-slop/no-object-parameters -- Builds an arbitrarily deep filter payload.
const nested = (n: number, value: object): object => (n ? { not: nested(n - 1, value) } : value)

const appErrors = defineErrorContract({ NOT_FOUND: { message: 'Not found', details: {} } })
const errors = combineErrorContracts(appErrors, argumentErrors)
const args = { title: z.string().min(3, 'Title is too short') }

describe('argument failure policy', () => {
	it('default payload is unchanged', async () => {
		const fn = zCustomQuery(queryGeneric, NoOp)({ args, handler: () => null })
		const legacy = zCustomFunctions({ argumentFailure: 'legacy' }).zCustomQuery(
			queryGeneric,
			NoOp,
		)({ args, handler: () => null })
		for (const target of [fn, legacy]) {
			const error = await rejection(target, { title: 'x' })
			expect(dataOf(error)).toEqual({
				ZodError: [
					expect.objectContaining({
						code: 'too_small',
						path: ['title'],
						message: 'Title is too short',
					}),
				],
			})
			expect(decodeFailure(error, errors)).toEqual({ _tag: 'UnknownFailure', version: 1 })
		}
	})

	it.each([['query'], ['mutation'], ['action']] as const)(
		"'declared' %s failures decode after combineErrorContracts",
		async (kind) => {
			const builders = zCustomFunctions({ argumentFailure: 'declared' })
			const definition = { args, handler: () => null }
			const fn =
				kind === 'query'
					? builders.zCustomQuery(queryGeneric, NoOp)(definition)
					: kind === 'mutation'
						? builders.zCustomMutation(mutationGeneric, NoOp)(definition)
						: builders.zCustomAction(actionGeneric, NoOp)(definition)
			const error = await rejection(fn, { title: 'x' })
			expect(dataOf(error)).toEqual({
				_tag: 'DeclaredFailure',
				version: 1,
				code: 'INVALID_ARGUMENTS',
				message: 'Invalid arguments',
				details: {
					issues: [{ path: ['title'], code: 'too_small', message: 'Title is too short' }],
				},
			})
			const message = matchFailure(error, errors, {
				INVALID_ARGUMENTS: (failure) => failure.details.issues[0]?.message ?? failure.message,
				NOT_FOUND: (failure) => failure.message,
				_: () => 'Something went wrong',
			})
			expect(message).toBe('Title is too short')
			expect(failureOf(error, errors, 'INVALID_ARGUMENTS')?.details.issues).toHaveLength(1)
		},
	)

	it('custom hook decides what is thrown', async () => {
		const seen: ArgumentFailure[] = []
		const app = defineErrorContract({
			INVALID_INPUT: { message: 'Invalid input', details: {} },
		})
		const builders = zCustomFunctions({
			argumentFailure: (failure) => {
				seen.push(failure)
				return app.toConvexError('INVALID_INPUT', {})
			},
		})
		const fn = builders.zCustomQuery(queryGeneric, NoOp)({ args, handler: () => null })
		const error = await rejection(fn, { title: 'x' })
		expect(failureOf(error, app, 'INVALID_INPUT')?.code).toBe('INVALID_INPUT')
		expect(seen).toEqual([
			{
				source: 'arguments',
				issues: [{ path: ['title'], code: 'too_small', message: 'Title is too short' }],
			},
		])
	})

	it('filter-boundary rejections use the same mechanism, before customization', async () => {
		const events: string[] = []
		const input = () => {
			events.push('input')
			return { ctx: {}, args: {} }
		}
		const legacy = zCustomQuery(queryGeneric, { args: {}, input })({
			args: compactArgs(),
			handler: () => null,
		})
		const legacyError = await rejection(legacy, { filters: nested(9, { value: 7 }) })
		expect(dataOf(legacyError)).toEqual({
			ZodError: [expect.objectContaining({ path: ['filters'] })],
		})

		const sources: string[] = []
		const declared = zCustomFunctions({
			argumentFailure: (failure) => {
				sources.push(failure.source)
				return argumentErrors.toConvexError('INVALID_ARGUMENTS', { issues: [...failure.issues] })
			},
		}).zCustomQuery(queryGeneric, { args: {}, input })({
			get args() {
				return compactArgs()
			},
			handler: () => null,
		})
		for (const filters of [nested(9, { value: 7 }), { value: 7 }]) {
			const error = await rejection(declared, { filters })
			const failure = failureOf(error, errors, 'INVALID_ARGUMENTS')
			expect(failure?.details.issues[0]?.path[0]).toBe('filters')
		}
		expect(sources).toEqual(['filter', 'filter'])
		expect(events).toEqual([])
	})

	it('auth constructors thread argumentFailure', async () => {
		const readers = createAuthReaders<GenericDataModel, 'reader'>({
			query: queryGeneric,
			action: actionGeneric,
			internalQuery: internalQueryGeneric,
			internalAction: internalActionGeneric,
			getAuthUser: async () => null,
			mapRole: () => 'reader',
			adminRoles: ['reader'],
			argumentFailure: 'declared',
		})
		const fn = readers.systemQuery({ args, handler: () => null })
		const error = await rejection(fn, { title: 'x' })
		expect(failureOf(error, errors, 'INVALID_ARGUMENTS')?.code).toBe('INVALID_ARGUMENTS')
	})
})

describe('argument issue allowlist', () => {
	it('drops input-like fields and bounds counts and lengths', () => {
		const issues = Array.from({ length: 50 }, (_, index) => ({
			code: 'invalid_type',
			path: ['a', index, Symbol('s'), 'x'.repeat(500)],
			message: 'm'.repeat(1000),
			input: 'secret-input',
			received: 'secret-received',
			params: { secret: true },
		}))
		const sanitized = sanitizeArgumentIssues(issues)
		expect(sanitized).toHaveLength(ARGUMENT_ISSUE_LIMITS.issues)
		expect(JSON.stringify(sanitized)).not.toContain('secret')
		expect(Object.keys(sanitized[0]!).sort()).toEqual(['code', 'message', 'path'])
		expect(sanitized[0]!.message).toHaveLength(ARGUMENT_ISSUE_LIMITS.messageLength)
		expect(sanitized[0]!.path).toEqual([
			'a',
			0,
			'',
			'x'.repeat(ARGUMENT_ISSUE_LIMITS.segmentLength),
		])
		expect(() => argumentErrors.envelope('INVALID_ARGUMENTS', { issues: sanitized })).not.toThrow()
	})

	it('declared mode never echoes the rejected value', async () => {
		const fn = zCustomFunctions({ argumentFailure: 'declared' }).zCustomQuery(
			queryGeneric,
			NoOp,
		)({
			args: { secret: z.number() },
			handler: () => null,
		})
		const error = await rejection(fn, { secret: 'hunter2-value' })
		expect(JSON.stringify(dataOf(error))).not.toContain('hunter2')
	})

	it('decode rejects oversized or extra-key transported details', () => {
		const envelope = (issues: readonly object[]) => ({
			_tag: 'DeclaredFailure',
			version: 1,
			code: 'INVALID_ARGUMENTS',
			message: 'Invalid arguments',
			details: { issues },
		})
		const issue = { path: ['a'], code: 'custom', message: 'bad' }
		expect(argumentErrors.decode(envelope([issue]))._tag).toBe('DeclaredFailure')
		expect(argumentErrors.decode(envelope([{ ...issue, input: 'x' }]))._tag).toBe('UnknownFailure')
		expect(argumentErrors.decode(envelope(Array(21).fill(issue)))._tag).toBe('UnknownFailure')
		expect(argumentErrors.decode(envelope([{ ...issue, message: 'm'.repeat(257) }]))._tag).toBe(
			'UnknownFailure',
		)
		expect(argumentErrors.decode({ ...envelope([issue]), ZodError: [] })._tag).toBe(
			'UnknownFailure',
		)
	})
})

describe('argument failure transport budget', () => {
	it('keeps a maximal failure decodable after serialization', () => {
		const issues = sanitizeArgumentIssues(
			Array.from({ length: 50 }, () => ({
				path: Array.from({ length: 64 }, () => 'é'.repeat(500)),
				code: 'custom',
				message: '"'.repeat(1000),
			})),
		)
		expect(issues.length).toBeGreaterThan(0)
		expect(issues.length).toBeLessThan(ARGUMENT_ISSUE_LIMITS.issues)
		const error = argumentErrors.toConvexError('INVALID_ARGUMENTS', { issues })
		const wire = new ConvexError(JSON.parse(JSON.stringify(error.data)))
		expect(new TextEncoder().encode(JSON.stringify(error.data)).length).toBeLessThan(65_536)
		expect(decodeFailure(wire, argumentErrors)._tag).toBe('DeclaredFailure')
	})
})
