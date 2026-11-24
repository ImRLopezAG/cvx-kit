import { Cause, Effect, Exit } from 'effect'
import { convexTest } from 'convex-test'
import {
	defineSchema,
	defineTable,
	type DataModelFromSchemaDefinition,
	type GenericMutationCtx,
} from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { combineErrorContracts, defineErrorContract } from '../src/modules/contracts/errors'
import { defineDomainContract } from '../src/modules/contracts/domain'
import { createEffectFoundation } from '../src/modules/effect/foundation'
import { effectErrors } from '../src/modules/effect/failures'

const schema = defineSchema({ writes: defineTable({ kind: v.string() }) })
type Host = GenericMutationCtx<DataModelFromSchemaDefinition<typeof schema>>
const modules = import.meta.glob('./fixture/**/*.ts')
const errors = defineErrorContract({
	NOT_FOUND: { message: 'Not found', details: {} },
	LIMIT: { message: 'Limit reached', details: { max: z.number() } },
})
const { fail, attempt } = effectErrors(errors)

function failureOf<Value, Error>(exit: Exit.Exit<Value, Error>) {
	if (Exit.isSuccess(exit)) throw Error('expected failure')
	const reason = exit.cause.reasons[0]
	return reason
}

describe('effectErrors', () => {
	it('fails with a trusted declared error, with optional empty details', async () => {
		const exit = await Effect.runPromiseExit(fail('NOT_FOUND'))
		const reason = failureOf(exit)
		if (!Cause.isFailReason(reason)) throw Error('expected typed failure')
		expect(errors.project(reason.error)).toMatchObject({ code: 'NOT_FOUND', details: {} })
		const limited = failureOf(await Effect.runPromiseExit(fail('LIMIT', { max: 3 })))
		if (!Cause.isFailReason(limited)) throw Error('expected typed failure')
		expect(errors.project(limited.error)).toMatchObject({ code: 'LIMIT', details: { max: 3 } })
	})

	it('dies when details fail their declared parser', async () => {
		// SAFETY: deliberately bypass the parsed detail type to reach the runtime parser.
		const invalid = fail('LIMIT', { max: 'x' as never })
		const reason = failureOf(await Effect.runPromiseExit(invalid))
		expect(Cause.isDieReason(reason)).toBe(true)
	})

	it('recovers thrown declared errors and declared ConvexErrors through catchTag', async () => {
		for (const thrown of [errors.create('NOT_FOUND', {}), errors.toConvexError('NOT_FOUND', {})]) {
			const recovered = await Effect.runPromise(
				attempt(async () => {
					throw thrown
				}).pipe(
					Effect.catchTag('DeclaredError', (error) =>
						Effect.succeed(
							errors.project(error)._tag === 'DeclaredFailure' ? error.code : 'untrusted',
						),
					),
				),
			)
			expect(recovered).toBe('NOT_FOUND')
		}
	})

	it('keeps unknown throws as defects', async () => {
		const boom = Error('boom')
		for (const thrown of [
			boom,
			new ConvexError({
				_tag: 'DeclaredFailure',
				version: 1,
				code: 'OTHER',
				message: 'x',
				details: {},
			}),
			{ _tag: 'DeclaredError', code: 'NOT_FOUND', details: {} },
		]) {
			const reason = failureOf(
				await Effect.runPromiseExit(
					attempt(() => {
						throw thrown
					}),
				),
			)
			if (!Cause.isDieReason(reason)) throw Error('expected defect')
			expect(reason.defect).toBe(thrown)
		}
	})

	it('runs synchronous work', async () => {
		expect(await Effect.runPromise(attempt(() => 5))).toBe(5)
	})
})

describe('contracted registry factories', () => {
	it('expose fail and attempt bound to the contract errors', async () => {
		const foundation = createEffectFoundation({
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'F' }),
			},
			writeAudit: () => undefined,
		})
		const contract = defineDomainContract({
			errors,
			commands: {
				'notes.save': { input: z.string(), result: z.string(), classification: 'business' },
			},
		})
		const notes = foundation.Command({
			contract,
			context: (host: Host) => host,
			audit: () => null,
			operations: ({ command, fail: failNote, attempt: attemptNote }) => ({
				'notes.save': command.handler((input, ctx) =>
					Effect.gen(function* () {
						yield* attemptNote(() => ctx.db.insert('writes', { kind: input }))
						if (input === 'missing') return yield* failNote('NOT_FOUND')
						return input
					}),
				),
			}),
		})
		const t = convexTest(schema, modules)
		expect(
			await t.mutation((host) => Effect.runPromise(notes.exec('notes.save', 'ok', host))),
		).toBe('ok')
		const code = await t.mutation(async (host) => {
			const reason = failureOf(
				await Effect.runPromiseExit(notes.exec('notes.save', 'missing', host)),
			)
			return Cause.isFailReason(reason) ? errors.project(reason.error) : null
		})
		expect(code).toMatchObject({ code: 'NOT_FOUND' })
	})

	it('omit the helpers when the contract cannot create errors', () => {
		const foundation = createEffectFoundation({
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'F' }),
			},
			writeAudit: () => undefined,
		})
		const seen: string[] = []
		const queries = foundation.Query({
			contract: defineDomainContract({
				errors: combineErrorContracts(errors),
				queries: { 'notes.get': { input: z.string(), result: z.string() } },
			}),
			context: () => ({}),
			operations: (define) => {
				seen.push(...Object.keys(define))
				return { 'notes.get': define.query.handler((input) => input) }
			},
		})
		expect(queries.exec).toBeTypeOf('function')
		void Effect.runPromise(queries.exec('notes.get', 'x', undefined))
		expect(seen).toEqual(['query'])
	})
})
