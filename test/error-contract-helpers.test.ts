import { describe, expect, it } from 'vite-plus/test'
import { ConvexError } from 'convex/values'
import { z } from 'zod'
import { Effect } from 'effect'
import { convexTest } from 'convex-test'
import {
	defineSchema,
	queryGeneric,
	mutationGeneric,
	actionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	internalActionGeneric,
	anyApi,
} from 'convex/server'
import { createEffectAuthFunctions } from '../src/effect'
import {
	combineErrorContracts,
	defineErrorContract,
	decodeFailure,
	failureOf,
	isFailure,
	matchFailure,
} from '../src/errors'

const first = defineErrorContract({
	SHARED: { message: 'Shared', details: { value: z.string() } },
	FIRST: { message: 'First', details: {} },
})
const second = defineErrorContract({
	SHARED: { message: 'Shared', details: { value: z.number() } },
	SECOND: { message: 'Second', details: {} },
})
const unknown = { _tag: 'UnknownFailure', version: 1 }

describe('error contract helpers', () => {
	it('keeps empty combinations unknown', () => {
		expect(combineErrorContracts().project(new Error())).toEqual(unknown)
		expect(combineErrorContracts().decode({})).toEqual(unknown)
	})
	it('combines duplicate codes without losing either schema or trusted ownership', () => {
		const combined = combineErrorContracts(first, second)
		expect(combined).not.toHaveProperty('create')
		for (const [owner, value] of [
			[first, 'one'],
			[second, 2],
		] as const) {
			const error =
				value === 'one' ? first.create('SHARED', { value }) : second.create('SHARED', { value })
			const envelope = owner.project(error)
			expect(combined.project(error)).toEqual(envelope)
			expect(combined.decode(envelope)).toEqual(envelope)
			expect(combined.project(new ConvexError(envelope))).toEqual(envelope)
			expect(combined.project(new ConvexError(JSON.stringify(envelope)))).toEqual(envelope)
			expect(combined.project({ ...error })).toEqual(unknown)
		}
		expect(
			combined.project(
				defineErrorContract({ FOREIGN: { message: 'Foreign', details: {} } }).create('FOREIGN', {}),
			),
		).toEqual(unknown)
		expect(first.project(new ConvexError(first.envelope('FIRST', {})))).toEqual(unknown)
		expect(
			combined.project(new ConvexError({ ...first.envelope('FIRST', {}), stack: 'private' })),
		).toEqual(unknown)
	})
	it('uses the first successful decoder in declaration order', () => {
		const a = defineErrorContract({
			SAME: { message: 'Same', details: { value: z.coerce.string() } },
		})
		const b = defineErrorContract({ SAME: { message: 'Same', details: { value: z.number() } } })
		const payload = b.envelope('SAME', { value: 2 })
		expect(combineErrorContracts(a, b).decode(payload)).toEqual({
			...payload,
			details: { value: '2' },
		})
		expect(combineErrorContracts(b, a).decode(payload)).toEqual(payload)
	})
	it('constructs with identical create validation, projection and isolated data', () => {
		const input = { value: 'safe', private: 'secret' }
		const envelope = first.envelope('SHARED', input)
		expect(envelope).toEqual(first.project(first.create('SHARED', input)))
		expect(decodeFailure(first.toConvexError('SHARED', input), first)).toEqual(envelope)
		// SAFETY: deliberately invalid runtime input proves all constructors use identical validation.
		const invalid = { value: 1 } as never
		for (const method of [first.create, first.envelope, first.toConvexError])
			expect(() => method('SHARED', invalid)).toThrow('Invalid declared error details')
		expect(envelope.details).toEqual({ value: 'safe' })
	})
	it('parses only bounded ConvexError.data JSON and applies the identical strict decoder', () => {
		const valid = first.project(first.create('SHARED', { value: 'é' }))
		expect(decodeFailure(new ConvexError(JSON.stringify(valid)), first)).toEqual(valid)
		const base = JSON.stringify(first.project(first.create('SHARED', { value: '' })))
		const exact = base.replace(
			'"value":""',
			'"value":"' + 'a'.repeat(65536 - new TextEncoder().encode(base).length) + '"',
		)
		expect(new TextEncoder().encode(exact).length).toBe(65536)
		expect(decodeFailure(new ConvexError(exact), first)._tag).toBe('DeclaredFailure')
		const unicode = JSON.stringify(
			first.project(first.create('SHARED', { value: 'é'.repeat(33000) })),
		)
		expect(unicode.length).toBeLessThan(65536)
		for (const error of [
			new ConvexError(exact + ' '),
			new ConvexError(unicode),
			new ConvexError('{'),
			new ConvexError(JSON.stringify({ ...valid, details: { value: 'safe', private: 'secret' } })),
			new ConvexError(JSON.stringify({ ...valid, message: 'private' })),
			new ConvexError(JSON.stringify({ ...valid, code: 'OTHER' })),
			new Error(JSON.stringify(valid)),
			{ data: JSON.stringify(valid) },
		]) {
			expect(decodeFailure(error, first)).toEqual(unknown)
			expect(isFailure(error, first, 'SHARED', 'FIRST')).toBe(false)
			expect(failureOf(error, first, 'SHARED')).toBeUndefined()
		}
	})
	it('returns selected declared failures without mutating or narrowing raw errors', () => {
		const combined = combineErrorContracts(first, second)
		const error = second.toConvexError('SHARED', { value: 2 })
		const keys = Reflect.ownKeys(error)
		expect(isFailure(error, combined, 'FIRST', 'SHARED')).toBe(true)
		expect(failureOf(error, combined, 'FIRST', 'SHARED')?.details).toEqual({ value: 2 })
		expect(failureOf(error, combined, 'FIRST', 'SECOND')).toBeUndefined()
		expect(Reflect.ownKeys(error)).toEqual(keys)
		expect(error).not.toHaveProperty('failure')
		expect(isFailure(error, combined)).toBe(false)
		expect(failureOf(error, combined)).toBeUndefined()
		expect(
			matchFailure(error, combined, {
				FIRST: () => 0,
				SECOND: () => 1,
				SHARED: ({ details }) => details.value,
			}),
		).toBe(2)
	})
	it('observes installed Convex registration serialization for mutation and action errors', async () => {
		const mutation = mutationGeneric({
			args: {},
			handler: () => {
				throw first.toConvexError('FIRST', {})
			},
		})
		const action = actionGeneric({
			args: {},
			handler: () => {
				throw first.toConvexError('FIRST', {})
			},
		})
		// SAFETY: installed registered functions expose native invocation hooks; public typings intentionally omit these runtime hooks.
		const invokeMutation = (
			mutation as typeof mutation & { invokeMutation: (args: string) => Promise<string> }
		).invokeMutation
		// SAFETY: same installed registration hook, with the action request ID argument.
		const invokeAction = (
			action as typeof action & {
				invokeAction: (requestId: string, args: string) => Promise<string>
			}
		).invokeAction
		for (const invoke of [() => invokeMutation('[{}]'), () => invokeAction('proof', '[{}]')]) {
			let caught: unknown
			try {
				await invoke()
			} catch (error) {
				caught = error
			}
			expect(caught).toBeInstanceOf(ConvexError)
			if (!(caught instanceof ConvexError)) throw Error('Expected ConvexError')
			expect(caught.data).toEqual(expect.any(String))
			expect(decodeFailure(caught, first)).toEqual(first.envelope('FIRST', {}))
		}
	})
	it('projects trusted and rethrown failures through registered auth policies, rejecting forgeries', async () => {
		const combined = combineErrorContracts(first, second)
		const builders = {
			query: queryGeneric,
			mutation: mutationGeneric,
			action: actionGeneric,
			internalQuery: internalQueryGeneric,
			internalMutation: internalMutationGeneric,
			internalAction: internalActionGeneric,
		}
		const auth = createEffectAuthFunctions(
			{
				...builders,
				getAuthUser: async () => ({ id: 'reader' }),
				mapRole: () => 'reader' as const,
				adminRoles: [],
			},
			{
				query: { errors: combined },
				mutation: {},
				action: {},
				systemQuery: {},
				systemMutation: {},
				systemAction: {},
			},
		)
		const trusted = auth.authQuery({
			args: {},
			handler: () => Effect.fail(second.create('SHARED', { value: 2 })),
		})
		const rethrown = auth.authQuery({
			args: {},
			handler: () =>
				Effect.fail(new ConvexError(JSON.stringify(second.envelope('SHARED', { value: 2 })))),
		})
		const forged = auth.authQuery({
			args: {},
			handler: () => Effect.fail({ _tag: 'DeclaredError', code: 'SHARED', details: { value: 2 } }),
		})
		const malformed = auth.authQuery({
			args: {},
			handler: () =>
				Effect.fail(
					new ConvexError({
						...second.envelope('SHARED', { value: 2 }),
						details: { value: 2, private: 'secret' },
					}),
				),
		})
		const t = convexTest(defineSchema({}), {
			'./_generated/server.ts': async () => builders,
			'./functions.ts': async () => ({ trusted, rethrown, forged, malformed }),
		})
		for (const name of ['trusted', 'rethrown', 'forged', 'malformed']) {
			let caught: unknown
			try {
				await t
					.withIdentity({ subject: 'reader', org_id: 'org', role: 'reader' })
					.query(anyApi.functions[name], {})
			} catch (e) {
				caught = e
			}
			expect(caught).toBeInstanceOf(ConvexError)
			if (!(caught instanceof ConvexError)) throw Error('Expected ConvexError')
			expect(caught.data).toEqual(
				name === 'forged' || name === 'malformed'
					? unknown
					: second.envelope('SHARED', { value: 2 }),
			)
		}
	})
})
