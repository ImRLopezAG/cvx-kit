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
import { Foundation } from '../src/components/foundation/client'

const schema = defineSchema({
	writes: defineTable({ kind: v.string(), key: v.string() }),
})
type Context = GenericMutationCtx<
	DataModelFromSchemaDefinition<typeof schema>
>
const modules = import.meta.glob('./fixture/**/*.ts')
type Failure =
	'result' | 'audit-resolution' | 'aggregate' | 'audit-write' | 'completion'
function harness(
	options: {
		fail?: Failure
		deny?: boolean
		replay?: unknown
		auditNull?: boolean
	} = {},
) {
	const events: string[] = []
	const aggregates: string[] = ['document']
	const { Command } = new Foundation(
		{ functions: { status: null } },
		{
			checkPermission: () => {
				events.push('permission')
				if (options.deny) throw Error('DENIED')
			},
			observability: {
				enabled: true,
				classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
				emit: (event) => {
					events.push(`observe:${event.outcome}`)
				},
				writeAudit: async (ctx: Context, entry) => {
					events.push('audit-write')
					await ctx.db.insert('writes', {
						kind: 'audit',
						key: entry.aggregate.id,
					})
					if (options.fail === 'audit-write') throw Error('audit-write')
				},
			},
		},
	)
	const operations = {
		save: Command.withContext<Context>().operation({
			command: z.object({ key: z.string().trim() }),
			result: z
				.object({ ok: z.literal(true) })
				.refine(() => options.fail !== 'result'),
			classification: 'business',
			permission: 'save',
			aggregates,
			prepare: async (context, command) => {
				events.push(`prepare:${command.key}`)
				if ('replay' in options)
					return { kind: 'replay', result: options.replay }
				return {
					kind: 'execute',
					complete: async (result) => {
						expect(result.ok).toBe(true)
						events.push(`complete:${command.key}`)
						await context.db.insert('writes', {
							kind: 'completion',
							key: command.key,
						})
						if (options.fail === 'completion') throw Error('completion')
					},
				}
			},
			guard: () => {
				events.push('guard')
			},
			audit: ({ command }) => {
				events.push('audit-resolution')
				if (options.fail === 'audit-resolution')
					throw Error('audit-resolution')
				if (options.auditNull) return null
				return {
					operation: 'save',
					actorId: 'actor',
					aggregate: {
						type: options.fail === 'aggregate' ? 'wrong' : 'document',
						id: command.key,
					},
				}
			},
		}),
	}
	const commands = new Command<Context, typeof operations>(operations)
	const execute = commands.exec({
		operation: 'save',
		handler: async (context, command) => {
			events.push(`handler:${command.key}`)
			await context.db.insert('writes', {
				kind: 'business',
				key: command.key,
			})
			return { ok: true }
		},
	})
	return { events, execute, commands }
}

describe('transactional command completion', () => {
	it('persists and replays validated transformed output without repeating effects or transforms', async () => {
		const receiptSchema = defineSchema({
			receipts: defineTable({
				key: v.string(),
				fingerprint: v.string(),
				result: v.number(),
			}).index('by_key', ['key']),
		})
		type ReceiptContext = GenericMutationCtx<
			DataModelFromSchemaDefinition<typeof receiptSchema>
		>
		const t = convexTest(receiptSchema, modules)
		let transforms = 0
		let effects = 0
		let audits = 0
		const { Command } = new Foundation(
			{ functions: { status: null } },
			{
				observability: {
					enabled: false,
					classifyError: () => ({ outcome: 'failed', errorCode: 'ERROR' }),
					writeAudit: () => {
						audits++
					},
				},
			},
		)
		const operations = {
			measure: Command.withContext<ReceiptContext>().operation({
				command: z.object({ key: z.string(), title: z.string().trim() }),
				result: z.string().transform((value) => {
					transforms++
					return value.length
				}),
				replayResult: z.number().int().nonnegative(),
				classification: 'business',
				prepare: async (context, command) => {
					const receipt = await context.db
						.query('receipts')
						.withIndex('by_key', (q) => q.eq('key', command.key))
						.unique()
					if (receipt) {
						if (receipt.fingerprint !== command.title)
							throw Error('FINGERPRINT_CONFLICT')
						return { kind: 'replay', result: receipt.result }
					}
					return {
						kind: 'execute',
						complete: async (result) => {
							await context.db.insert('receipts', {
								key: command.key,
								fingerprint: command.title,
								result,
							})
						},
					}
				},
				audit: () => ({
					operation: 'measure',
					actorId: 'actor',
					aggregate: { type: 'document', id: 'document' },
				}),
			}),
		}
		const execute = new Command<ReceiptContext, typeof operations>(
			operations,
		).exec({
			operation: 'measure',
			handler: (_ctx, command) => {
				effects++
				return command.title
			},
		})
		expect(
			await t.mutation((ctx) =>
				execute(ctx, { key: 'key', title: ' hello ' }),
			),
		).toBe(5)
		expect(
			await t.mutation((ctx) =>
				execute(ctx, { key: 'key', title: 'hello' }),
			),
		).toBe(5)
		expect({ transforms, effects, audits }).toEqual({
			transforms: 1,
			effects: 1,
			audits: 1,
		})
		await expect(
			t.mutation((ctx) => execute(ctx, { key: 'key', title: 'different' })),
		).rejects.toThrow('FINGERPRINT_CONFLICT')
		await t.run(async (ctx) => {
			const receipt = await ctx.db.query('receipts').unique()
			if (receipt) await ctx.db.patch(receipt._id, { result: -1 })
		})
		await expect(
			t.mutation((ctx) => execute(ctx, { key: 'key', title: 'hello' })),
		).rejects.toThrow()
		expect({ transforms, effects, audits }).toEqual({
			transforms: 1,
			effects: 1,
			audits: 1,
		})
	})
	it('finishes audit and durable completion before observation, using parsed input', async () => {
		const h = harness()
		const t = convexTest(schema, modules)
		await t.mutation((ctx) => h.execute(ctx, { key: ' key ' }))
		expect(h.events).toEqual([
			'permission',
			'prepare:key',
			'guard',
			'handler:key',
			'audit-resolution',
			'audit-write',
			'complete:key',
			'observe:completed',
		])
		expect(
			await t.run((ctx) => ctx.db.query('writes').collect()),
		).toHaveLength(3)
	})
	for (const fail of [
		'result',
		'audit-resolution',
		'aggregate',
		'audit-write',
		'completion',
	] as const) {
		it(`rolls back actual host writes and observes failure on ${fail}`, async () => {
			const h = harness({ fail })
			const t = convexTest(schema, modules)
			await expect(
				t.mutation((ctx) => h.execute(ctx, { key: 'key' })),
			).rejects.toThrow()
			expect(
				await t.run((ctx) => ctx.db.query('writes').collect()),
			).toEqual([])
			expect(h.events.at(-1)).toBe('observe:failed')
			if (fail !== 'completion')
				expect(h.events).not.toContain('complete:key')
		})
	}
	it('completes audit-null work', async () => {
		const h = harness({ auditNull: true })
		const t = convexTest(schema, modules)
		await t.mutation((ctx) => h.execute(ctx, { key: 'key' }))
		expect(h.events).not.toContain('audit-write')
		expect(h.events.slice(-2)).toEqual([
			'complete:key',
			'observe:completed',
		])
	})
	it('validates replay and skips guards, business writes and audit', async () => {
		const h = harness({ replay: { ok: true } })
		const t = convexTest(schema, modules)
		expect(
			await t.mutation((ctx) => h.execute(ctx, { key: 'key' })),
		).toEqual({ ok: true })
		expect(h.events).toEqual([
			'permission',
			'prepare:key',
			'observe:completed',
		])
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toEqual(
			[],
		)
	})
	it('rejects invalid durable replay', async () => {
		const h = harness({ replay: { ok: false } })
		const t = convexTest(schema, modules)
		await expect(
			t.mutation((ctx) => h.execute(ctx, { key: 'key' })),
		).rejects.toThrow()
		expect(h.events).toEqual([
			'permission',
			'prepare:key',
			'observe:failed',
		])
	})
	it('checks permission before replay lookup', async () => {
		const h = harness({ deny: true, replay: { ok: true } })
		const t = convexTest(schema, modules)
		await expect(
			t.mutation((ctx) => h.execute(ctx, { key: 'key' })),
		).rejects.toThrow('DENIED')
		expect(h.events).toEqual(['permission', 'observe:failed'])
	})
	it('isolates repeated and nested calls with the same context and key', async () => {
		const h = harness()
		const t = convexTest(schema, modules)
		const nested = h.commands.exec({
			operation: 'save',
			handler: async (ctx) => {
				await h.execute(ctx, { key: 'key' })
				return { ok: true }
			},
		})
		await t.mutation(async (ctx) => {
			await nested(ctx, { key: 'key' })
			await h.execute(ctx, { key: 'key' })
		})
		expect(
			h.events.filter((event) => event === 'complete:key'),
		).toHaveLength(3)
		expect(
			await t.run((ctx) => ctx.db.query('writes').collect()),
		).toHaveLength(8)
	})
	it('documents that swallowing a failure inside the mutation permits writes to commit', async () => {
		const h = harness({ fail: 'completion' })
		const t = convexTest(schema, modules)
		await t.mutation(async (ctx) => {
			try {
				await h.execute(ctx, { key: 'key' })
			} catch {
				return null
			}
		})
		expect(
			await t.run((ctx) => ctx.db.query('writes').collect()),
		).toHaveLength(3)
		expect(h.events.at(-1)).toBe('observe:failed')
	})
})
