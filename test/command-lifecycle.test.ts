import { convexTest } from 'convex-test'
import {
	defineSchema,
	defineTable,
	type DataModelFromSchemaDefinition,
	type GenericMutationCtx,
} from 'convex/server'
import { v } from 'convex/values'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'
import { z } from 'zod'
import {
	Foundation,
	type CommandHandlerResult,
	type CommandResult,
} from '../src/components/foundation/client'
import {
	convexContract,
	standardContract,
	zodContract,
	type StandardSchema,
} from '../src/contracts'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

const schema = defineSchema({
	writes: defineTable({ kind: v.string(), key: v.string() }),
})
type Context = GenericMutationCtx<DataModelFromSchemaDefinition<typeof schema>>
// Compile-checked public Promise declaration; assertions remain outside test callbacks.
const { Command: ContractCommand } = new Foundation(
	{ functions: { status: null } },
	{
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'ERROR' }),
		},
	},
)
const contractOperations = {
	measure: ContractCommand.withContext<Context>().operation({
		command: zodContract(z.string().transform(async (value) => value.length)),
		result: zodContract(z.number().transform(async (length) => ({ length }))),
		replayResult: convexContract(v.object({ length: v.number() })),
		classification: 'business',
		audit: ({ command, result }) => {
			const assertions: [
				Assert<Equal<typeof command, number>>,
				Assert<Equal<typeof result, { length: number }>>,
			] = [true, true]
			void assertions
			return null
		},
	}),
}
const contractCommands = new ContractCommand<Context, typeof contractOperations>(contractOperations)
const contractExecute = contractCommands.exec({
	operation: 'measure',
	handler: (_ctx, command) => command,
})
const contractAssertions: [
	Assert<Equal<Parameters<typeof contractExecute>[1], string>>,
	Assert<Equal<CommandHandlerResult<typeof contractOperations, 'measure'>, number>>,
	Assert<Equal<CommandResult<typeof contractOperations, 'measure'>, { length: number }>>,
	Assert<Equal<Awaited<ReturnType<typeof contractExecute>>, { length: number }>>,
] = [true, true, true, true]
void contractAssertions
function contractNegativeChecks(context: Context) {
	// @ts-expect-error callers supply raw input, not the decoded number
	void contractExecute(context, 3)
	// @ts-expect-error handler returns raw number, not transformed final result
	contractCommands.exec({ operation: 'measure', handler: () => ({ length: 3 }) })
	// @ts-expect-error operation keys remain literal
	contractCommands.exec({ operation: 'missing', handler: () => 3 })
	ContractCommand.withContext<Context>().operation({
		// @ts-expect-error optional Effect decoders cannot enter Promise declarations
		command: { kind: 'effect-contract', decode: () => Promise.resolve({ value: 3 }) },
		result: z.number(),
		classification: 'business',
		audit: () => null,
	})
}
void contractNegativeChecks

const modules = import.meta.glob('./fixture/**/*.ts')
type Failure = 'result' | 'audit-resolution' | 'aggregate' | 'audit-write' | 'completion'
function harness(
	options: {
		fail?: Failure
		deny?: boolean
		replay?: unknown
		auditNull?: boolean
		middleware?: boolean
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
			result: z.object({ ok: z.literal(true) }).refine(() => options.fail !== 'result'),
			classification: 'business',
			permission: 'save',
			aggregates,
			prepare: async (context, command) => {
				events.push(`prepare:${command.key}`)
				if ('replay' in options) return { kind: 'replay', result: options.replay }
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
			middleware: options.middleware
				? [
						async ({ next }) => {
							events.push('middleware')
							return next()
						},
					]
				: [],
			audit: ({ command }) => {
				events.push('audit-resolution')
				if (options.fail === 'audit-resolution') throw Error('audit-resolution')
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
	it('executes neutral adapters through public Promise declarations with decoded callback values', async () => {
		const events: string[] = []
		let inputDefect: Error | undefined
		const input: StandardSchema<{ key: string }, { key: number }> = {
			'~standard': {
				version: 1,
				vendor: 'test',
				validate: async (value) => {
					await Promise.resolve()
					events.push('input')
					if (inputDefect) throw inputDefect
					const parsed = z.object({ key: z.string() }).safeParse(value)
					if (!parsed.success) return { issues: parsed.error.issues }
					return { value: { key: parsed.data.key.trim().length } }
				},
			},
		}
		const result: StandardSchema<number, { length: number }> = {
			'~standard': {
				version: 1,
				vendor: 'test',
				validate: async (value) => {
					await Promise.resolve()
					events.push('result')
					const parsed = z.number().nonnegative().safeParse(value)
					return parsed.success
						? { value: { length: parsed.data } }
						: { issues: [{ message: 'invalid length' }] }
				},
			},
		}
		const { Command } = new Foundation(
			{ functions: { status: null } },
			{
				checkPermission: () => {
					events.push('permission')
				},
				observability: {
					enabled: false,
					classifyError: () => ({ outcome: 'failed', errorCode: 'ERROR' }),
					writeAudit: () => {
						events.push('audit-write')
					},
				},
			},
		)
		const resultContract = standardContract(result)
		let replay: { length: number } | undefined
		const typed = Command.withContext<Context>()
		const operations = {
			measure: typed.operation({
				command: input,
				result: resultContract,
				replayResult: zodContract(z.object({ length: z.number().nonnegative() })),
				classification: 'business',
				permission: 'measure',
				prepare: (_context, command) => {
					expectTypeOf(command).toEqualTypeOf<{ key: number }>()
					events.push('prepare')
					return replay === undefined
						? {
								kind: 'execute',
								complete: (final) => {
									expectTypeOf(final).toEqualTypeOf<{ length: number }>()
									events.push(`complete:${final.length}`)
								},
							}
						: { kind: 'replay', result: replay }
				},
				guard: (_context, command) => {
					events.push(`guard:${command.key}`)
				},
				audit: ({ command, result: final }) => {
					expectTypeOf(command).toEqualTypeOf<{ key: number }>()
					expectTypeOf(final).toEqualTypeOf<{ length: number }>()
					events.push(`audit:${final.length}`)
					return {
						operation: 'measure',
						actorId: 'actor',
						aggregate: { type: 'document', id: String(command.key) },
					}
				},
			}),
			convex: typed.operation({
				command: convexContract(v.object({ key: v.string() })),
				result: convexContract(v.number()),
				classification: 'business',
				audit: () => null,
			}),
		}
		expectTypeOf<CommandHandlerResult<typeof operations, 'measure'>>().toEqualTypeOf<number>()
		const commands = new Command<Context, typeof operations>(operations)
		const execute = commands.exec({
			operation: 'measure',
			handler: async (ctx, command) => {
				expectTypeOf(command).toEqualTypeOf<{ key: number }>()
				events.push(`handler:${command.key}`)
				await ctx.db.insert('writes', { kind: 'business', key: String(command.key) })
				return command.key === 0 ? -1 : command.key
			},
		})
		expectTypeOf(execute).parameter(1).toEqualTypeOf<{ key: string }>()
		expectTypeOf(execute).returns.resolves.toEqualTypeOf<{ length: number }>()
		const native = commands.exec({
			operation: 'convex',
			handler: (_ctx, command) => {
				expectTypeOf(command).toEqualTypeOf<{ key: string }>()
				return command.key.length
			},
		})
		expectTypeOf(native).parameter(1).toEqualTypeOf<{ key: string }>()
		expectTypeOf(native).returns.resolves.toEqualTypeOf<number>()
		const t = convexTest(schema, modules)
		expect(await t.mutation((ctx) => execute(ctx, { key: ' abc ' }))).toEqual({ length: 3 })
		expect(events).toEqual([
			'input',
			'permission',
			'prepare',
			'guard:3',
			'handler:3',
			'result',
			'audit:3',
			'audit-write',
			'complete:3',
		])
		events.length = 0
		// SAFETY: deliberately malformed caller input exercises runtime decoding beyond the static call contract.
		await expect(t.mutation((ctx) => execute(ctx, { key: 3 } as never))).rejects.toThrow()
		expect(events).toEqual(['input'])
		events.length = 0
		inputDefect = new Error('validator defect')
		await expect(t.mutation((ctx) => execute(ctx, { key: 'abc' }))).rejects.toBe(inputDefect)
		expect(events).toEqual(['input'])
		inputDefect = undefined
		events.length = 0
		await expect(t.mutation((ctx) => execute(ctx, { key: '' }))).rejects.toThrow()
		expect(events).toEqual(['input', 'permission', 'prepare', 'guard:0', 'handler:0', 'result'])
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toHaveLength(1)
		events.length = 0
		replay = { length: 9 }
		expect(await t.mutation((ctx) => execute(ctx, { key: 'abc' }))).toEqual({ length: 9 })
		expect(events).toEqual(['input', 'permission', 'prepare'])
		replay = { length: -1 }
		await expect(t.mutation((ctx) => execute(ctx, { key: 'abc' }))).rejects.toThrow()
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toHaveLength(1)
		expect(await t.mutation((ctx) => native(ctx, { key: 'abcd' }))).toBe(4)
		// SAFETY: deliberately extra transport fields exercise native strict-object validation.
		await expect(
			t.mutation((ctx) => native(ctx, { key: 'abcd', extra: true } as never)),
		).rejects.toThrow()
	})

	it('awaits input and result transforms before handler, audit, and completion', async () => {
		const events: string[] = []
		const t = convexTest(schema, modules)
		const { Command } = new Foundation(
			{ functions: { status: null } },
			{
				checkPermission: () => {
					events.push('permission')
				},
				observability: {
					enabled: false,
					classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
					writeAudit: async (ctx: Context, entry) => {
						events.push(`audit:${entry.aggregate.id}`)
						await ctx.db.insert('writes', { kind: 'audit', key: entry.aggregate.id })
					},
				},
			},
		)
		const operations = {
			save: Command.withContext<Context>().operation({
				command: z.object({ key: z.string() }).transform(async ({ key }) => {
					await Promise.resolve()
					events.push('input')
					return { key: key.trim() }
				}),
				result: z
					.string()
					.transform(async (key) => {
						await Promise.resolve()
						events.push('result')
						return { key }
					})
					.refine(({ key }) => key !== 'invalid'),
				classification: 'business',
				permission: 'save',
				prepare: () => ({
					kind: 'execute',
					complete: (result) => {
						events.push(`complete:${result.key}`)
					},
				}),
				audit: ({ result }) => ({
					operation: 'save',
					actorId: 'actor',
					aggregate: { type: 'document', id: result.key },
				}),
			}),
		}
		const execute = new Command<Context, typeof operations>(operations).exec({
			operation: 'save',
			handler: async (ctx, input) => {
				events.push(`handler:${input.key}`)
				await ctx.db.insert('writes', { kind: 'business', key: input.key })
				return input.key
			},
		})
		expect(await t.run((ctx) => execute(ctx, { key: ' document ' }))).toEqual({ key: 'document' })
		expect(events).toEqual([
			'input',
			'permission',
			'handler:document',
			'result',
			'audit:document',
			'complete:document',
		])
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toHaveLength(2)
		events.length = 0
		await expect(t.run((ctx) => execute(ctx, { key: 'invalid' }))).rejects.toThrow()
		expect(events).toEqual(['input', 'permission', 'handler:invalid', 'result'])
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toHaveLength(2)
	})

	it('persists and replays validated transformed output without repeating effects or transforms', async () => {
		const receiptSchema = defineSchema({
			receipts: defineTable({
				key: v.string(),
				fingerprint: v.string(),
				result: v.number(),
			}).index('by_key', ['key']),
		})
		type ReceiptContext = GenericMutationCtx<DataModelFromSchemaDefinition<typeof receiptSchema>>
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
						if (receipt.fingerprint !== command.title) throw Error('FINGERPRINT_CONFLICT')
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
		const execute = new Command<ReceiptContext, typeof operations>(operations).exec({
			operation: 'measure',
			handler: (_ctx, command) => {
				effects++
				return command.title
			},
		})
		expect(await t.mutation((ctx) => execute(ctx, { key: 'key', title: ' hello ' }))).toBe(5)
		expect(await t.mutation((ctx) => execute(ctx, { key: 'key', title: 'hello' }))).toBe(5)
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
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toHaveLength(3)
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
			await expect(t.mutation((ctx) => h.execute(ctx, { key: 'key' }))).rejects.toThrow()
			expect(await t.run((ctx) => ctx.db.query('writes').collect())).toEqual([])
			expect(h.events.at(-1)).toBe('observe:failed')
			if (fail !== 'completion') expect(h.events).not.toContain('complete:key')
		})
	}
	it('completes audit-null work', async () => {
		const h = harness({ auditNull: true })
		const t = convexTest(schema, modules)
		await t.mutation((ctx) => h.execute(ctx, { key: 'key' }))
		expect(h.events).not.toContain('audit-write')
		expect(h.events.slice(-2)).toEqual(['complete:key', 'observe:completed'])
	})
	it('validates replay and skips guards, business writes and audit', async () => {
		const h = harness({ replay: { ok: true } })
		const t = convexTest(schema, modules)
		expect(await t.mutation((ctx) => h.execute(ctx, { key: 'key' }))).toEqual({ ok: true })
		expect(h.events).toEqual(['permission', 'prepare:key', 'observe:completed'])
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toEqual([])
	})
	it('rejects invalid durable replay', async () => {
		const h = harness({ replay: { ok: false } })
		const t = convexTest(schema, modules)
		await expect(t.mutation((ctx) => h.execute(ctx, { key: 'key' }))).rejects.toThrow()
		expect(h.events).toEqual(['permission', 'prepare:key', 'observe:failed'])
	})
	it('checks permission before replay lookup', async () => {
		const h = harness({ deny: true, replay: { ok: true } })
		const t = convexTest(schema, modules)
		await expect(t.mutation((ctx) => h.execute(ctx, { key: 'key' }))).rejects.toThrow('DENIED')
		expect(h.events).toEqual(['permission', 'observe:failed'])
	})
	it('does not enter middleware for denied or replayed work', async () => {
		for (const deny of [true, false]) {
			const h = harness({ deny, replay: { ok: true }, middleware: true })
			const t = convexTest(schema, modules)
			if (deny)
				await expect(t.mutation((ctx) => h.execute(ctx, { key: 'key' }))).rejects.toThrow('DENIED')
			else await t.mutation((ctx) => h.execute(ctx, { key: 'key' }))
			expect(h.events).not.toContain('middleware')
			expect(h.events).not.toContain('guard')
			expect(h.events).not.toContain('complete:key')
		}
	})
	it('parses input before permission, preparation and observation', async () => {
		const h = harness({ middleware: true })
		const t = convexTest(schema, modules)
		// SAFETY: bypass caller typing to exercise malformed runtime input.
		await expect(t.mutation((ctx) => h.execute(ctx, { key: 4 } as never))).rejects.toThrow()
		expect(h.events).toEqual([])
	})
	it('allocates a fresh middleware dispatch for each reused executor invocation', async () => {
		const h = harness({ middleware: true })
		const t = convexTest(schema, modules)
		await t.mutation(async (ctx) => {
			await h.execute(ctx, { key: 'key' })
			await h.execute(ctx, { key: 'key' })
		})
		expect(h.events.filter((event) => event === 'middleware')).toHaveLength(2)
		expect(h.events.filter((event) => event === 'complete:key')).toHaveLength(2)
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
		expect(h.events.filter((event) => event === 'complete:key')).toHaveLength(3)
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toHaveLength(8)
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
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toHaveLength(3)
		expect(h.events.at(-1)).toBe('observe:failed')
	})
})
