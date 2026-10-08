import { Effect } from 'effect'
import { convexTest } from 'convex-test'
import {
	defineSchema,
	defineTable,
	type DataModelFromSchemaDefinition,
	type GenericMutationCtx,
} from 'convex/server'
import { v } from 'convex/values'
import { z } from 'zod'
import { expect, it } from 'vite-plus/test'
import { createEffectFoundation } from '../src/effect'

const schema = defineSchema({ writes: defineTable({ kind: v.string() }) })
type Host = GenericMutationCtx<DataModelFromSchemaDefinition<typeof schema>>
const modules = import.meta.glob('./fixture/**/*.ts')

it.each(['promise', 'effect'] as const)(
	'executes a nested %s audit Effect and rolls back its failed transaction',
	async (wrapper) => {
		const failure = new Error('audit failed')
		const foundation = createEffectFoundation({
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'ERROR' }),
			},
			writeAudit: (host: Host) => {
				const audit = Effect.gen(function* () {
					yield* Effect.promise(() => host.db.insert('writes', { kind: 'audit' }))
					return yield* Effect.fail(failure)
				})
				return wrapper === 'promise' ? Promise.resolve(audit) : Effect.succeed(audit)
			},
		})
		const commands = foundation.Command({
			context: (host: Host) => host,
			operations: ({ command }) => ({
				save: command({
					input: z.number(),
					result: z.number(),
					classification: 'business',
					handler: (input, host) =>
						Effect.promise(async () => {
							await host.db.insert('writes', { kind: 'business' })
							return input
						}),
					audit: () => ({
						operation: 'save',
						actorId: 'actor',
						aggregate: { type: 'document', id: 'id' },
					}),
				}),
			}),
		})
		const t = convexTest(schema, modules)
		await expect(
			t.mutation((host) => Effect.runPromise(commands.exec('save', 1, host))),
		).rejects.toBe(failure)
		expect(await t.query((host) => host.db.query('writes').collect())).toEqual([])
	},
)

it('validates a middleware short-circuit before audit and completion, skipping guards and handler', async () => {
	const events: string[] = []
	const foundation = createEffectFoundation({
		observability: {
			enabled: true,
			classifyError: () => ({ outcome: 'failed', errorCode: 'ERROR' }),
			emit: (event) => {
				events.push(event.outcome)
			},
		},
		checkPermission: () => {
			events.push('permission')
		},
		writeAudit: (host: Host) =>
			Effect.promise(async () => {
				events.push('write')
				await host.db.insert('writes', { kind: 'audit' })
			}),
	})
	const forbidden = () => {
		throw new Error('short-circuit must skip core')
	}
	const commands = foundation.Command({
		context: (host: Host) => host,
		defaults: { guard: forbidden },
		operations: ({ command }) => ({
			save: command({
				input: z.number(),
				result: z
					.number()
					.max(5)
					.transform((value) => {
						events.push('parse')
						return value + 1
					}),
				classification: 'business',
				permission: 'save',
				guard: forbidden,
				handler: forbidden,
				prepare: (host) => {
					events.push('prepare')
					return {
						kind: 'execute' as const,
						complete: (result: number) =>
							Effect.promise(async () => {
								events.push(`complete:${result}`)
								await host.db.insert('writes', { kind: 'completion' })
							}),
					}
				},
				middleware: ({ input }) => {
					events.push('middleware')
					return Effect.succeed(input)
				},
				audit: ({ result }) => {
					events.push(`audit:${result}`)
					return { operation: 'save', actorId: 'actor', aggregate: { type: 'document', id: 'id' } }
				},
			}),
		}),
	})
	const t = convexTest(schema, modules)
	expect(await t.mutation((host) => Effect.runPromise(commands.exec('save', 3, host)))).toBe(4)
	expect(events).toEqual([
		'permission',
		'prepare',
		'middleware',
		'parse',
		'audit:4',
		'write',
		'complete:4',
		'completed',
	])
	expect(
		await t.query(async (host) => (await host.db.query('writes').collect()).map((row) => row.kind)),
	).toEqual(['audit', 'completion'])
	events.length = 0
	await expect(
		t.mutation((host) => Effect.runPromise(commands.exec('save', 6, host))),
	).rejects.toThrow()
	expect(events).toEqual(['permission', 'prepare', 'middleware', 'failed'])
	expect(await t.query(async (host) => (await host.db.query('writes').collect()).length)).toBe(2)
})
