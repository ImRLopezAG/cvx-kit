import { Context, Effect, Exit, Schema, SchemaGetter } from 'effect'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { createEffectQuery } from '../src/modules/effect/query'
import { effectOperationFactory } from '../src/modules/effect/operation'
import { ContractValidationError, effectSchema } from '../src/effect'
import { zodContract } from '../src/contracts'

describe('Effect query registries', () => {
	it('provisions codec services lazily and blocks policy on invalid async input', async () => {
		class Decoder extends Context.Service<Decoder, string>()('QueryCodecDecoder') {}
		const calls: string[] = []
		const input = effectSchema(
			Schema.Number.pipe(
				Schema.decodeTo(Schema.String, {
					decode: SchemaGetter.transformEffect((value) =>
						Decoder.pipe(Effect.map((prefix) => `${prefix}${value}`)),
					),
					encode: SchemaGetter.transform(() => 0),
				}),
			),
		)
		const query = createEffectQuery({
			context: (host: {}) => {
				calls.push('context')
				return host
			},
			checkPermission: () => {
				calls.push('permission')
			},
			operations: ({ query }) => ({
				read: query({
					input,
					result: z.number(),
					permission: 'read',
					handler: (value) => value.length,
				}),
				invalid: query({
					input: zodContract(z.string().refine(async () => false)),
					result: z.string(),
					permission: 'read',
					handler: (value) => value,
				}),
			}),
		})
		const execution = query.exec('read', 2, {})
		expect(calls).toEqual([])
		expect(await Effect.runPromise(execution.pipe(Effect.provideService(Decoder, 'item:')))).toBe(6)
		calls.length = 0
		const exit = await Effect.runPromiseExit(query.exec('invalid', 'bad', {}))
		if (!Exit.isFailure(exit)) throw Error('expected validation failure')
		expect(exit.cause.reasons).toHaveLength(1)
		const reason = exit.cause.reasons[0]
		if (reason?._tag !== 'Fail') throw Error('expected typed validation failure')
		expect(reason.error).toBeInstanceOf(ContractValidationError)
		expect(reason.error).toMatchObject({
			issues: [{ code: 'custom', path: [], message: 'Invalid input' }],
		})
		expect(calls).toEqual([])
	})
	it('awaits contract transforms before policy, handler and completion', async () => {
		const calls: string[] = []
		const query = createEffectQuery({
			context: (host: {}) => {
				calls.push('context')
				return host
			},
			checkPermission: () => {
				calls.push('permission')
			},
			observability: {
				enabled: true,
				classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
				emit: ({ outcome }) => {
					calls.push(`observe:${outcome}`)
				},
			},
			operations: ({ query }) => ({
				read: query({
					input: z.string().transform(async (value) => {
						await Promise.resolve()
						calls.push('input')
						return value.trim()
					}),
					result: z.number().transform(async (value) => {
						await Promise.resolve()
						calls.push('result')
						return String(value)
					}),
					permission: 'read',
					handler: (input) => {
						calls.push('handler')
						return Effect.succeed(input.length)
					},
				}),
			}),
		})
		const execution = query.exec('read', ' abc ', {})
		expect(calls).toEqual([])
		expect(await Effect.runPromise(execution)).toBe('3')
		expect(calls).toEqual([
			'input',
			'permission',
			'context',
			'handler',
			'result',
			'observe:completed',
		])
	})
	it('is lazy and supports ordinary, gen and fn handlers with parsed contracts', async () => {
		const calls: string[] = []
		const query = createEffectQuery({
			context: (host: { actorId: string }) => {
				calls.push(`context:${host.actorId}`)
				return host
			},
			operations: ({ query }) => ({
				ordinary: query({
					input: z.string(),
					result: z.number(),
					handler: async (input) => input.length,
				}),
				generated: query({
					input: z.string().transform((input) => input.length),
					result: z.number().transform(String),
					handler: (input) =>
						Effect.gen(function* () {
							return yield* Effect.succeed(input + 1)
						}),
				}),
				named: query({
					input: z.number(),
					result: z.number(),
					handler: Effect.fn('query.named')(function* (input: number) {
						return yield* Effect.succeed(input + 1)
					}),
				}),
			}),
		})
		const execution = query.exec('generated', 'abc', { actorId: 'one' })
		expect(calls).toEqual([])
		expect(await Effect.runPromise(execution)).toBe('4')
		expect(await Effect.runPromise(query.exec('ordinary', 'abc', { actorId: 'two' }))).toBe(3)
		expect(await Effect.runPromise(query.exec('named', 3, { actorId: 'three' }))).toBe(4)
		expect(calls).toEqual(['context:one', 'context:two', 'context:three'])
	})
	it('enriches only the handler context and parses middleware replacement output once', async () => {
		const calls: string[] = []
		const enriched = effectOperationFactory<{ actorId: string }, { traceId: string }>()
		const query = createEffectQuery({
			context: (host: { actorId: string }) => host,
			operations: () => ({
				read: enriched.query({
					input: z.string(),
					result: z.number().transform((output) => {
						calls.push('parse')
						return String(output)
					}),
					guard: (context) => {
						calls.push(`guard:${context.traceId}`)
					},
					handler: (input, context) => {
						calls.push(`${context.actorId}:${context.traceId}`)
						return input.length
					},
					middleware: ({ next }) =>
						next({ context: { traceId: 'trace' } }).pipe(Effect.map((output) => output + 1)),
				}),
			}),
		})
		expect(await Effect.runPromise(query.exec('read', 'abc', { actorId: 'actor' }))).toBe('4')
		expect(calls).toEqual(['guard:trace', 'actor:trace', 'parse'])
	})
	it('creates fresh next state on reruns and rejects reused next inside one run', async () => {
		let runs = 0
		const query = createEffectQuery({
			context: (host: {}) => host,
			operations: ({ query }) => ({
				read: query({
					input: z.object({}),
					result: z.number(),
					handler: () => ++runs,
					middleware: ({ next }) => next(),
				}),
				invalid: query({
					input: z.object({}),
					result: z.number(),
					handler: () => 1,
					middleware: ({ next }) => next().pipe(Effect.flatMap(() => next())),
				}),
			}),
		})
		const reusable = query.exec('read', {}, {})
		expect(await Effect.runPromise(reusable)).toBe(1)
		expect(await Effect.runPromise(reusable)).toBe(2)
		await expect(Effect.runPromise(query.exec('invalid', {}, {}))).rejects.toThrow(/more than once/)
	})
	it('keeps actor providers isolated across concurrent invocations', async () => {
		const query = createEffectQuery({
			context: async (host: { actorId: string }) => ({ actorId: host.actorId }),
			operations: ({ query }) => ({
				read: query({
					input: z.object({}),
					result: z.string(),
					handler: (_input, context) => Effect.succeed(context.actorId),
				}),
			}),
		})
		expect(
			await Promise.all(
				['a', 'b'].map((actorId) => Effect.runPromise(query.exec('read', {}, { actorId }))),
			),
		).toEqual(['a', 'b'])
	})
	it('checks permission before middleware even when it short circuits', async () => {
		const calls: string[] = []
		const query = createEffectQuery({
			context: (host: { actorId: string }) => ({ actorId: host.actorId }),
			checkPermission: (host, { permission }) => {
				calls.push(`${host.actorId}:${permission}`)
				throw new Error('denied')
			},
			operations: ({ query }) => ({
				read: query({
					input: z.object({}),
					result: z.number(),
					permission: 'read',
					handler: () => 1,
					middleware: () => {
						calls.push('middleware')
						return 2
					},
				}),
			}),
		})
		await expect(Effect.runPromise(query.exec('read', {}, { actorId: 'actor' }))).rejects.toThrow(
			'denied',
		)
		expect(calls).toEqual(['actor:read'])
	})
	it('fails closed when permission policy is absent and isolates telemetry defects', async () => {
		const query = createEffectQuery({
			context: (host: {}) => host,
			observability: {
				enabled: true,
				classifyError: () => {
					throw new Error('classifier')
				},
				emit: () => {
					throw new Error('emitter')
				},
			},
			operations: ({ query }) => ({
				denied: query({
					input: z.object({}),
					result: z.number(),
					permission: 'read',
					handler: () => 1,
				}),
				read: query({ input: z.object({}), result: z.number(), handler: () => 1 }),
			}),
		})
		await expect(Effect.runPromise(query.exec('denied', {}, {}))).rejects.toThrow(/permission/i)
		expect(await Effect.runPromise(query.exec('read', {}, {}))).toBe(1)
	})
	it('checks a declared empty permission and observes after final validation', async () => {
		const calls: string[] = []
		const query = createEffectQuery({
			context: (host: {}) => host,
			checkPermission: (_host, { permission }) => {
				calls.push(`permission:${permission}`)
			},
			observability: {
				enabled: true,
				classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
				emit: ({ outcome }) => {
					calls.push(`observe:${outcome}`)
				},
			},
			operations: ({ query }) => ({
				read: query({
					input: z.object({}),
					result: z.number().transform((output) => {
						calls.push('parse')
						return String(output)
					}),
					permission: '',
					handler: () => {
						calls.push('handler')
						return 1
					},
				}),
			}),
		})
		expect(await Effect.runPromise(query.exec('read', {}, {}))).toBe('1')
		expect(calls).toEqual(['permission:', 'handler', 'parse', 'observe:completed'])
	})
	it('preserves typed failures and defects when failure telemetry throws', async () => {
		const expected = new Error('original')
		const failures: unknown[] = []
		const query = createEffectQuery({
			context: (host: {}) => host,
			observability: {
				enabled: true,
				classifyError: (cause) => {
					failures.push(cause)
					throw new Error('classifier')
				},
			},
			operations: ({ query }) => ({
				expected: query({
					input: z.object({}),
					result: z.number(),
					handler: () => Effect.fail(expected),
				}),
				defect: query({
					input: z.object({}),
					result: z.number(),
					handler: () => {
						throw expected
					},
				}),
			}),
		})
		await expect(Effect.runPromise(query.exec('expected', {}, {}))).rejects.toThrow('original')
		await expect(Effect.runPromise(query.exec('defect', {}, {}))).rejects.toThrow('original')
		expect(failures).toEqual([expected, expected])
	})
})

it('binds query context while retaining explicit execution', async () => {
	const queries = createEffectQuery({
		context: (prefix: string) => ({ prefix }),
		operations: ({ query }) => ({
			read: query({
				input: z.number(),
				result: z.string(),
				handler: (value, ctx) => `${ctx.prefix}:${value}`,
			}),
		}),
	})
	expect(await Effect.runPromise(queries.withContext('bound').exec('read', 1))).toBe('bound:1')
	expect(await Effect.runPromise(queries.exec('read', 2, 'explicit'))).toBe('explicit:2')
})
