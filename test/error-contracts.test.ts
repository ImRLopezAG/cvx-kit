import { Cause, Context, Effect, Exit } from 'effect'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { defineErrorContract } from '../src/modules/contracts/errors'
import { projectErrorCause } from '../src/modules/effect/errors'

const errors = defineErrorContract({
	NotFound: { message: 'Record not found', details: { id: z.string() } },
	Conflict: { message: 'Conflict', details: { revision: z.number().int() } },
})
const unknown = { _tag: 'UnknownFailure', version: 1 }
type CyclicDetail = { child?: CyclicDetail }

describe('declared safe error contracts', () => {
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
