import { convexTest } from 'convex-test'
import {
	queryGeneric,
	mutationGeneric,
	actionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	internalActionGeneric,
	anyApi,
	type DataModelFromSchemaDefinition,
} from 'convex/server'
import { createEffectAuthFunctions } from '../src/effect'
import { createQueryEngine, queryFailureContract } from '../src/querying'
import { queryErrors } from '../src/errors'
import { groupDeclarations } from './fixture-querying/field-groups'
import { cursor } from './fixture-querying/scalar'
import { Cause, Context, Effect, Exit } from 'effect'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { ConvexError } from 'convex/values'
import { decodeFailure, matchFailure } from '../src/react/failures'
import { defineErrorContract } from '../src/modules/contracts/errors'
import { projectErrorCause } from '../src/modules/effect/errors'

const errors = defineErrorContract({
	NotFound: { message: 'Record not found', details: { id: z.string() } },
	Conflict: { message: 'Conflict', details: { revision: z.number().int() } },
})
const unknown = { _tag: 'UnknownFailure', version: 1 }
type CyclicDetail = { child?: CyclicDetail }

describe('declared safe error contracts', () => {
	it('supports a declared underscore code with a fallback that narrows the full failure union', () => {
		const contract = defineErrorContract({
			_: { message: 'Underscore', details: { id: z.string() } },
		})
		const handlers = {
			_: (failure: ReturnType<typeof contract.decode>) =>
				failure._tag === 'DeclaredFailure' ? failure.details.id : 'unknown',
		}
		expect(matchFailure(new Error('network'), contract, handlers)).toBe('unknown')
		expect(
			matchFailure(
				new ConvexError(contract.project(contract.create('_', { id: 'one' }))),
				contract,
				handlers,
			),
		).toBe('one')
	})
	it('projects only declared fields and decodes a JSON round trip', () => {
		const providerDetails = { id: 'record-1', private: 'secret' }
		const error = errors.create('NotFound', providerDetails)
		const envelope = errors.project(error)
		expect(envelope).toEqual({
			_tag: 'DeclaredFailure',
			version: 1,
			code: 'NotFound',
			message: 'Record not found',
			details: { id: 'record-1' },
		})
		expect(errors.decode(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope)
		expect(JSON.stringify(envelope)).not.toContain('secret')
	})

	it('rejects forged server errors and omits private diagnostics on unknown failures', () => {
		for (const error of [
			{ _tag: 'DeclaredError', code: 'NotFound', details: { id: '1' } },
			new Error('provider credentials', { cause: { token: 'secret' } }),
			{ code: 'NotFound', message: 'private', stack: 'private stack' },
		])
			expect(errors.project(error)).toEqual(unknown)
		const other = defineErrorContract({
			NotFound: { message: 'Other', details: { id: z.string() } },
		})
		expect(errors.project(other.create('NotFound', { id: '1' }))).toEqual(unknown)
	})

	it('rejects malformed, undeclared and diagnostic-bearing transport data', () => {
		const valid = errors.project(errors.create('NotFound', { id: '1' }))
		for (const payload of [
			null,
			'NotFound',
			{},
			{ _tag: 'DeclaredFailure' },
			{ ...valid, version: 2 },
			{ ...valid, code: 'Undeclared' },
			{ ...valid, message: 'private provider message' },
			{ ...valid, details: { id: 2 } },
			{ ...valid, details: { id: '1', token: 'secret' } },
			{ ...valid, stack: 'private' },
			{ ...valid, cause: 'private' },
		])
			expect(errors.decode(payload)).toEqual(unknown)
	})

	it('validates detail fields and rejects non-JSON parser output without exposing validator text', () => {
		// SAFETY: deliberately bypass the static caller contract to test runtime rejection of malformed input.
		expect(() => errors.create('NotFound', { id: 1 } as never)).toThrow(
			'Invalid declared error details',
		)
		const unsafe = defineErrorContract({
			Unsafe: { message: 'Safe', details: { value: { parse: () => NaN } } },
		})
		expect(() => unsafe.create('Unsafe', { value: NaN })).toThrow('Invalid declared error details')
		const cyclic: CyclicDetail = {}
		cyclic.child = cyclic
		const cyclicParser = defineErrorContract({
			Cycle: { message: 'Safe', details: { value: { parse: () => cyclic } } },
		})
		expect(() => cyclicParser.create('Cycle', { value: cyclic })).toThrow(
			'Invalid declared error details',
		)
	})

	it('does not let mutation of created errors or projections change later public data', () => {
		const nested = defineErrorContract({
			Nested: { message: 'Safe', details: { value: z.object({ id: z.string() }) } },
		})
		const error = nested.create('Nested', { value: { id: 'safe' } })
		error.details.value.id = 'private'
		const first = nested.project(error)
		if (first._tag !== 'DeclaredFailure') throw Error('expected declared failure')
		first.details.value.id = 'private projection'
		expect(nested.project(error)).toEqual({
			_tag: 'DeclaredFailure',
			version: 1,
			code: 'Nested',
			message: 'Safe',
			details: { value: { id: 'safe' } },
		})
	})

	it('projects a singular declared failure, but rejects the whole composite, defect or interrupt Cause', async () => {
		const error = errors.create('NotFound', { id: '1' })
		expect(projectErrorCause(errors, Cause.fail(error))).toEqual(errors.project(error))
		for (const cause of [
			Cause.empty,
			Cause.fail({ code: 'NotFound' }),
			Cause.die(error),
			Cause.interrupt(1),
			Cause.combine(Cause.fail(error), Cause.die(Error('cleanup secret'))),
			Cause.combine(Cause.fail(error), Cause.interrupt(1)),
			Cause.combine(Cause.fail(error), Cause.fail(errors.create('Conflict', { revision: 2 }))),
		])
			expect(projectErrorCause(errors, cause)).toEqual(unknown)
		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				Effect.acquireRelease(Effect.succeed(Context.empty()), () =>
					Effect.die(Error('cleanup private')),
				).pipe(Effect.flatMap(() => Effect.fail(error))),
			),
		)
		if (Exit.isSuccess(exit)) throw Error('expected failure')
		expect(projectErrorCause(errors, exit.cause)).toEqual(unknown)
	})
})

describe('client failure decoding and matching', () => {
	it('extracts only ConvexError.data and dispatches declared codes', () => {
		const envelope = errors.project(errors.create('Conflict', { revision: 4 }))
		const error = new ConvexError(envelope)
		expect(decodeFailure(error, errors)).toEqual(envelope)
		expect(
			matchFailure(error, errors, {
				NotFound: ({ details }) => details.id,
				Conflict: ({ details }) => String(details.revision),
				_: () => 'unknown',
			}),
		).toBe('4')
		expect(matchFailure(new Error('network'), errors, { _: () => 'unknown' })).toBe('unknown')
		expect(
			matchFailure(new Error('network'), errors, {
				NotFound: () => 'found',
				Conflict: () => 'conflict',
			}),
		).toEqual(unknown)
	})
	it('contains malformed data, foreign objects, throwing getters and revoked proxies', () => {
		const valid = errors.project(errors.create('NotFound', { id: 'safe' }))
		const dataGetter = new ConvexError(valid)
		Object.defineProperty(dataGetter, 'data', {
			get() {
				throw Error('private-getter')
			},
		})
		const badPayload = new ConvexError({})
		Object.defineProperty(badPayload.data, '_tag', {
			get() {
				throw Error('private-tag')
			},
		})
		const proxy = Proxy.revocable({}, {})
		proxy.revoke()
		for (const error of [
			null,
			undefined,
			'Invalid cursor',
			valid,
			{ data: valid },
			new Error('private-network', { cause: 'private-cause' }),
			dataGetter,
			badPayload,
			new ConvexError({ ...valid, code: 'foreign' }),
			new ConvexError({ ...valid, cause: 'private-cause' }),
			proxy.proxy,
		]) {
			expect(decodeFailure(error, errors)).toEqual(unknown)
			expect(JSON.stringify(decodeFailure(error, errors))).not.toContain('private')
		}
	})
})

describe('registered auth endpoint query-failure transport', () => {
	it('exposes only fixed raw envelopes for real cursor, group and fan-out failures', async () => {
		const f = groupDeclarations()
		type DM = DataModelFromSchemaDefinition<typeof f.schema>
		const builders = {
			query: queryGeneric,
			mutation: mutationGeneric,
			action: actionGeneric,
			internalQuery: internalQueryGeneric,
			internalMutation: internalMutationGeneric,
			internalAction: internalActionGeneric,
		}
		const auth = createEffectAuthFunctions<DM, 'reader'>(
			{
				...builders,
				getAuthUser: async (ctx) => {
					const identity = await ctx.auth.getUserIdentity()
					return identity ? { id: identity.subject } : null
				},
				mapRole: () => 'reader',
				adminRoles: [],
			},
			{
				query: { errors: queryFailureContract },
				mutation: {},
				action: {},
				systemQuery: {},
				systemMutation: {},
				systemAction: {},
			},
		)
		const engine = createQueryEngine(f, {
			cursor,
			fieldGroups: { clients: { finance: () => false } },
		})
		const invalid = auth.authQuery({
			args: {},
			handler: (ctx) =>
				Effect.tryPromise({
					try: () => engine(ctx).clients.paginate({ numItems: 1, cursor: 'private-bad-cursor' }),
					catch: (error) => error,
				}),
		})
		const group = auth.authQuery({
			args: {},
			handler: (ctx) =>
				Effect.tryPromise({
					try: () =>
						engine(ctx)
							.clients.include({ finance: 'required' })
							.paginate({ numItems: 1, cursor: null }),
					catch: (error) => error,
				}),
		})
		// Membership expansion on an indexed filter has an actual hard fan-out ceiling.
		const fanoutEngine = createQueryEngine(f, {
			cursor,
			fieldGroups: { clients: { finance: () => true } },
		})
		const fanout = auth.authQuery({
			args: {},
			handler: (ctx) =>
				Effect.tryPromise({
					try: () =>
						fanoutEngine(ctx)
							.clients.where({ balance: { in: Array.from({ length: 33 }, (_, i) => BigInt(i)) } })
							.include({ finance: 'required' })
							.paginate({ numItems: 1, cursor: null }),
					catch: (error) => error,
				}),
		})
		const unrelated = auth.authQuery({
			args: {},
			handler: () => {
				throw Error('Invalid cursor QUERY_FANOUT private-id', { cause: 'private-cause' })
			},
		})
		const forged = auth.authQuery({
			args: {},
			handler: () => {
				throw { code: 'invalid-cursor', _tag: 'CursorError' }
			},
		})
		const t = convexTest(f.schema, {
			'./_generated/server.ts': async () => builders,
			'./failures.ts': async () => ({ invalid, group, fanout, unrelated, forged }),
		})
		const client = t.withIdentity({ subject: 'user', org_id: 'one', role: 'reader' })
		for (const [name, code] of [
			['invalid', 'invalid-cursor'],
			['group', 'FIELD_GROUP_DENIED'],
			['fanout', 'QUERY_FANOUT'],
			['unrelated', null],
			['forged', null],
		] as const) {
			let caught: unknown
			try {
				await client.query(anyApi.failures[name], {})
			} catch (error) {
				caught = error
			}
			expect(caught).toBeInstanceOf(ConvexError)
			if (!(caught instanceof ConvexError)) throw Error('Expected transported failure')
			console.log('raw-envelope', name, caught.data)
			const expected = code
				? {
						_tag: 'DeclaredFailure',
						version: 1,
						code,
						message:
							code === 'invalid-cursor'
								? 'Invalid cursor'
								: code === 'FIELD_GROUP_DENIED'
									? 'Field group access denied'
									: 'Query fan-out limit exceeded',
						details: {},
					}
				: unknown
			// Raw assertions precede decoding so a forgiving decoder cannot hide server leaks.
			expect(caught.data).toEqual(expected)
			expect(JSON.stringify(caught.data)).not.toMatch(/private|cause|stack|token|by_balance/)
			expect(decodeFailure(caught, queryErrors)).toEqual(expected)
		}
	})
})
