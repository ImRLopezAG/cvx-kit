import { Context, Effect, Exit } from 'effect'
import { convexTest } from 'convex-test'
import {
	defineSchema,
	defineTable,
	type DataModelFromSchemaDefinition,
	type GenericMutationCtx,
} from 'convex/server'
import { v } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { bindEffectCommand } from '../src/components/foundation/modules/effect/command'
import { Observability } from '../src/components/foundation/modules/observability/observability'

const schema = defineSchema({ writes: defineTable({ kind: v.string() }) })
type Host = GenericMutationCtx<DataModelFromSchemaDefinition<typeof schema>>
const modules = import.meta.glob('./fixture/**/*.ts')
class Repository extends Context.Service<Repository, { value: number }>()('CommandRepository') {}
class Policy extends Context.Service<Policy, { allowed: boolean }>()('CommandPolicy') {}
class Denied {
	readonly _tag = 'Denied'
}
class CompleteFailure {
	readonly _tag = 'CompleteFailure'
}
type Failure = 'result' | 'audit' | 'aggregate' | 'write' | 'complete'

function harness(
	options: { failure?: Failure; denied?: boolean; replay?: unknown; telemetry?: boolean } = {},
) {
	const events: string[] = []
	const create = bindEffectCommand({
		observability: new Observability({
			enabled: true,
			classifyError: () => {
				if (options.telemetry) throw Error('classifier failed')
				return { outcome: 'failed', errorCode: 'FAILURE' }
			},
			emit: (event) => {
				events.push(`observe:${event.outcome}`)
				if (options.telemetry) throw Error('emitter failed')
			},
			clock: () => {
				if (options.telemetry) throw Error('clock failed')
				return Date.now()
			},
		}),
		checkPermission: (_host: Host) =>
			Effect.sync(() => {
				events.push('permission')
				if (options.denied) throw Error('DENIED')
			}),
		writeAudit: (host: Host) =>
			Effect.gen(function* () {
				events.push('write')
				yield* Effect.promise(() => host.db.insert('writes', { kind: 'audit' }))
				if (options.failure === 'write') return yield* Effect.fail(Error('write'))
			}),
	})
	const commands = create({
		context: (host: Host) => {
			events.push('context')
			return { host, actor: 'trusted' }
		},
		defaults: {
			guard: () =>
				Effect.sync(() => {
					events.push('defaultGuard')
				}),
		},
		operations: ({ command }) => ({
			save: command({
				input: z.string().trim(),
				result: z.literal('saved').refine(() => options.failure !== 'result'),
				classification: 'business',
				permission: 'save',
				aggregates: ['document'],
				prepare: (context, input) => {
					events.push(`prepare:${input}:${context.actor}`)
					if ('replay' in options) return { kind: 'replay' as const, result: options.replay }
					return {
						kind: 'execute' as const,
						complete: () =>
							Effect.gen(function* () {
								events.push('complete')
								yield* Effect.promise(() =>
									context.host.db.insert('writes', { kind: 'completion' }),
								)
								if (options.failure === 'complete') return yield* Effect.fail(new CompleteFailure())
							}),
					}
				},
				guard: () =>
					Effect.gen(function* () {
						events.push('guard')
						if (!(yield* Policy).allowed) return yield* Effect.fail(new Denied())
					}),
				handler: (input, context) =>
					Effect.gen(function* () {
						events.push(`handler:${input}`)
						yield* Repository
						yield* Effect.promise(() => context.host.db.insert('writes', { kind: 'business' }))
						return 'saved' as const
					}),
				middleware: ({ next }) =>
					Effect.gen(function* () {
						events.push('middleware')
						return yield* next()
					}),
				audit: (_result, context) => {
					events.push(`audit:${context.actor}`)
					if (options.failure === 'audit') throw Error('audit')
					return {
						operation: 'save',
						actorId: context.actor,
						// SAFETY: intentionally corrupt the aggregate to characterize runtime allowlist enforcement.
						aggregate: {
							type: (options.failure === 'aggregate' ? 'wrong' : 'document') as 'document',
							id: 'id',
						},
					}
				},
			}),
		}),
	})
	const provided = (host: Host) =>
		commands
			.exec('save', ' title ', host)
			.pipe(
				Effect.provideService(Repository, { value: 1 }),
				Effect.provideService(Policy, { allowed: true }),
			)
	return { events, commands, provided }
}

describe('Effect command lifecycle', () => {
	it('observes resolver failure and keeps resolver execution lazy', async () => {
		const cause = Error('resolver')
		const observed: unknown[] = []
		let calls = 0
		const create = bindEffectCommand({
			observability: new Observability({
				enabled: true,
				classifyError: (cause) => {
					observed.push(cause)
					return { outcome: 'failed', errorCode: 'FAILED' }
				},
				emit: () => undefined,
			}),
			writeAudit: () => undefined,
		})
		const commands = create({
			context: (_host: Record<never, never>) =>
				Effect.suspend(() => {
					calls++
					return Effect.fail(cause)
				}),
			operations: ({ command }) => ({
				save: command({
					input: z.number(),
					result: z.number(),
					classification: 'business',
					audit: () => null,
					handler: (input) => input,
				}),
			}),
		})
		const effect = commands.exec('save', 1, {})
		expect(calls).toBe(0)
		await expect(Effect.runPromise(effect)).rejects.toBe(cause)
		expect(calls).toBe(1)
		expect(observed).toEqual([cause])
	})
	it('preserves original host/domain context and parses middleware output once', async () => {
		const events: string[] = []
		let parses = 0
		const create = bindEffectCommand({
			observability: new Observability({
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
			}),
			checkPermission: (host: { actor: string }) => {
				events.push(`permission:${host.actor}`)
			},
			writeAudit: (host: { actor: string }) => {
				events.push(`writer:${host.actor}`)
			},
		})
		const commands = create({
			context: (_host: { actor: string }) => ({ actor: 'domain' }),
			operations: ({ command }) => ({
				save: command({
					input: z.string().trim(),
					result: z.string().transform((value) => {
						parses++
						return value.length
					}),
					classification: 'business',
					permission: 'save',
					prepare: (context) => {
						events.push(`prepare:${context.actor}`)
						return {
							kind: 'execute' as const,
							complete: () => {
								events.push(`complete:${context.actor}`)
							},
						}
					},
					guard: (context) => {
						events.push(`guard:${context.actor}`)
					},
					handler: (input, context) => {
						events.push(`handler:${context.actor}`)
						return input
					},
					middleware: ({ next }) =>
						next({ context: { actor: 'enriched' } }).pipe(Effect.map((result) => `${result}!`)),
					audit: (_resolution, context) => {
						events.push(`audit:${context.actor}`)
						return {
							operation: 'save',
							actorId: 'actor',
							aggregate: { type: 'document', id: 'id' },
						}
					},
				}),
			}),
		})
		expect(await Effect.runPromise(commands.exec('save', ' hi ', { actor: 'host' }))).toBe(3)
		expect(parses).toBe(1)
		expect(events).toEqual([
			'permission:host',
			'prepare:domain',
			'guard:enriched',
			'handler:enriched',
			'audit:domain',
			'writer:host',
			'complete:domain',
		])
	})
	it('fails closed before short-circuit middleware when a permission checker is missing', async () => {
		let entered = false
		const create = bindEffectCommand({
			observability: new Observability({
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
			}),
			writeAudit: () => undefined,
		})
		const commands = create({
			context: (_host: Record<never, never>) => ({}),
			operations: ({ command }) => ({
				save: command({
					input: z.number(),
					result: z.number(),
					classification: 'business',
					permission: 'save',
					audit: () => null,
					handler: (input) => input,
					middleware: () => {
						entered = true
						return 1
					},
				}),
			}),
		})
		await expect(Effect.runPromise(commands.exec('save', 1, {}))).rejects.toMatchObject({
			code: 'COMMAND_PERMISSION_NOT_CONFIGURED',
		})
		expect(entered).toBe(false)
	})
	it('is lazy and completes durable work before observation', async () => {
		const h = harness()
		const t = convexTest(schema, modules)
		await t.mutation(async (host) => {
			const effect = h.provided(host)
			expect(h.events).toEqual([])
			expect(await Effect.runPromise(effect)).toBe('saved')
		})
		expect(h.events).toEqual([
			'context',
			'permission',
			'prepare:title:trusted',
			'middleware',
			'defaultGuard',
			'guard',
			'handler:title',
			'audit:trusted',
			'write',
			'complete',
			'observe:completed',
		])
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toHaveLength(3)
	})
	it('reuses one Effect value with fresh provider, preparation and dispatch state', async () => {
		const h = harness()
		const t = convexTest(schema, modules)
		await t.mutation(async (host) => {
			const effect = h.provided(host)
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* effect
					yield* effect
				}),
			)
		})
		for (const event of ['context', 'permission', 'middleware', 'complete', 'observe:completed'])
			expect(h.events.filter((value) => value === event)).toHaveLength(2)
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toHaveLength(6)
	})
	it('checks permission before replay and skips the middleware core on replay', async () => {
		for (const denied of [true, false]) {
			const h = harness({ denied, replay: 'saved' })
			const t = convexTest(schema, modules)
			if (denied)
				await expect(t.mutation((host) => Effect.runPromise(h.provided(host)))).rejects.toThrow(
					'DENIED',
				)
			else expect(await t.mutation((host) => Effect.runPromise(h.provided(host)))).toBe('saved')
			expect(h.events).not.toContain('middleware')
			expect(h.events).not.toContain('complete')
			expect(h.events.some((value) => value.startsWith('handler'))).toBe(false)
			if (denied) expect(h.events.some((value) => value.startsWith('prepare'))).toBe(false)
			expect(await t.run((ctx) => ctx.db.query('writes').collect())).toEqual([])
		}
	})
	it('rejects malformed replay without business or audit writes', async () => {
		const h = harness({ replay: 'wrong' })
		const t = convexTest(schema, modules)
		await expect(t.mutation((host) => Effect.runPromise(h.provided(host)))).rejects.toThrow()
		expect(h.events.at(-1)).toBe('observe:failed')
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toEqual([])
	})
	for (const failure of ['result', 'audit', 'aggregate', 'write', 'complete'] as const) {
		it(`rolls back actual domain/audit/completion writes on ${failure} failure`, async () => {
			const h = harness({ failure })
			const t = convexTest(schema, modules)
			await expect(t.mutation((host) => Effect.runPromise(h.provided(host)))).rejects.toBeDefined()
			expect(await t.run((ctx) => ctx.db.query('writes').collect())).toEqual([])
			expect(h.events.at(-1)).toBe('observe:failed')
		})
	}
	it('keeps telemetry inert on success and preserves the original failure', async () => {
		const success = harness({ telemetry: true })
		const t = convexTest(schema, modules)
		expect(await t.mutation((host) => Effect.runPromise(success.provided(host)))).toBe('saved')
		const failed = harness({ telemetry: true, failure: 'complete' })
		await expect(
			t.mutation((host) => Effect.runPromise(failed.provided(host))),
		).rejects.toBeInstanceOf(CompleteFailure)
	})
	it('normalizes ordinary, Promise, generator and named handlers without extra runners', async () => {
		const create = bindEffectCommand({
			observability: new Observability({
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
			}),
			writeAudit: () => undefined,
		})
		const commands = create({
			context: (_host: Record<never, never>) => ({}),
			operations: ({ command }) => ({
				plain: command({
					input: z.number(),
					result: z.number(),
					classification: 'business',
					audit: () => null,
					handler: (input) => input,
				}),
				promise: command({
					input: z.number(),
					result: z.number(),
					classification: 'business',
					audit: () => null,
					handler: async (input) => input,
				}),
				gen: command({
					input: z.number(),
					result: z.number(),
					classification: 'business',
					audit: () => null,
					handler: (input) =>
						Effect.gen(function* () {
							return yield* Effect.succeed(input)
						}),
				}),
				fn: command({
					input: z.number(),
					result: z.number(),
					classification: 'business',
					audit: () => null,
					handler: Effect.fn('named.command')(function* (input: number) {
						return yield* Effect.succeed(input)
					}),
				}),
			}),
		})
		expect(
			await Effect.runPromise(
				Effect.gen(function* () {
					return (
						(yield* commands.exec('plain', 1, {})) +
						(yield* commands.exec('promise', 2, {})) +
						(yield* commands.exec('gen', 3, {})) +
						(yield* commands.exec('fn', 4, {}))
					)
				}),
			),
		).toBe(10)
	})
	it('checks repeated next execution, including yielding the same next Effect twice', async () => {
		const create = bindEffectCommand({
			observability: new Observability({
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
			}),
			writeAudit: () => undefined,
		})
		const commands = create({
			context: (_host: Record<never, never>) => ({}),
			operations: ({ command }) => ({
				duplicate: command({
					input: z.number(),
					result: z.number(),
					classification: 'business',
					audit: () => null,
					handler: (input) => input,
					middleware: ({ next }) =>
						Effect.gen(function* () {
							const effect = next()
							yield* effect
							return yield* effect
						}),
				}),
			}),
		})
		const effect = commands.exec('duplicate', 1, {})
		for (let index = 0; index < 2; index++)
			await expect(Effect.runPromise(effect)).rejects.toThrow(/more than once/)
	})
	it('keeps defects, typed failures, rejected Promises and interruption failed', async () => {
		const original = Error('original')
		for (const callback of [
			() => Effect.fail(original),
			() => Effect.die(original),
			() => Promise.reject(original),
			() => Effect.interrupt,
		]) {
			const observed: unknown[] = []
			const create = bindEffectCommand({
				observability: new Observability({
					enabled: true,
					classifyError: (cause) => {
						observed.push(cause)
						return { outcome: 'failed', errorCode: 'FAILURE' }
					},
					emit: () => undefined,
				}),
				writeAudit: () => undefined,
			})
			const commands = create({
				context: (_host: Record<never, never>) => ({}),
				operations: ({ command }) => ({
					fail: command({
						input: z.number(),
						result: z.number(),
						classification: 'business',
						audit: () => null,
						handler: (): Effect.Effect<never, Error> | Promise<never> => callback(),
					}),
				}),
			})
			const exit = await Effect.runPromiseExit(commands.exec('fail', 1, {}))
			expect(Exit.isFailure(exit)).toBe(true)
			expect(observed).toHaveLength(1)
			if (
				Exit.isFailure(exit) &&
				exit.cause.reasons.length === 1 &&
				exit.cause.reasons[0]._tag !== 'Interrupt'
			)
				expect(observed[0]).toBe(original)
		}
	})
})
