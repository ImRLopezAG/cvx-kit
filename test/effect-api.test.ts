import { Cause, Context, Effect, Schema, SchemaGetter } from 'effect'
import { convexTest } from 'convex-test'
import {
	actionGeneric,
	makeFunctionReference,
	defineSchema,
	defineTable,
	internalMutationGeneric,
	mutationGeneric,
	queryGeneric,
	type DataModelFromSchemaDefinition,
	type GenericMutationCtx,
	type MutationBuilder,
} from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'
import { effectApiBuilder } from '../src/modules/effect/api'
import { defineErrorContract } from '../src/modules/contracts/errors'
import { effectSchema } from '../src/effect'

class Request extends Context.Service<Request, { value: number }>()('ApiRequest') {}
const schema = defineSchema({ writes: defineTable({ kind: v.string() }) })
type Host = GenericMutationCtx<DataModelFromSchemaDefinition<typeof schema>>
const modules = import.meta.glob('./fixture/**/*.ts')
const nativeMutation: MutationBuilder<
	DataModelFromSchemaDefinition<typeof schema>,
	'public'
> = mutationGeneric

// Convex intentionally omits this runtime field from its public registration declarations.
function invoke<Ctx, Args, Value>(
	registered: { isConvexFunction: true },
	ctx: Ctx,
	args: Args,
): Promise<Value> {
	// SAFETY: Every argument comes from a Convex builder, which retains its runtime _handler field.
	return (
		registered as { isConvexFunction: true; _handler: (ctx: Ctx, args: Args) => Promise<Value> }
	)._handler(ctx, args)
}

describe('Effect native API', () => {
	it('decodes domain data and encodes its wire result within one invocation scope', async () => {
		class Decoder extends Context.Service<Decoder, string>()('ApiCodecDecoder') {}
		class Encoder extends Context.Service<Encoder, number>()('ApiCodecEncoder') {}
		const codec = effectSchema(
			Schema.Number.pipe(
				Schema.decodeTo(Schema.String, {
					decode: SchemaGetter.transformEffect((value) =>
						Decoder.pipe(Effect.map((prefix) => `${prefix}${value}`)),
					),
					encode: SchemaGetter.transformEffect(() => Encoder),
				}),
			),
		)
		const events: string[] = []
		const query = effectApiBuilder(queryGeneric, {
			services: () =>
				Effect.acquireRelease(
					Effect.sync(() => {
						events.push('acquire')
						return Context.merge(Context.make(Decoder, 'domain:'), Context.make(Encoder, 7))
					}),
					() =>
						Effect.sync(() => {
							events.push('release')
						}),
				),
		})
		const registered = query({
			args: { value: v.number() },
			returns: v.number(),
			handler: (_ctx, { value }) =>
				codec.decode(value).pipe(
					Effect.tap((domain) =>
						Effect.sync(() => {
							events.push(domain)
						}),
					),
					Effect.flatMap(codec.encode),
				),
		})
		expect(await invoke(registered, {}, { value: 3 })).toBe(7)
		expect(events).toEqual(['acquire', 'domain:3', 'release'])
	})
	it('rejects safe declared failures and composite unknown failures with rollback', async () => {
		const errors = defineErrorContract({ DENIED: { message: 'Access denied', details: {} } })
		for (const cleanupFailure of [false, true]) {
			const t = convexTest(schema, modules)
			const mutation = effectApiBuilder(nativeMutation, {
				services: () =>
					Effect.acquireRelease(Effect.succeed(Context.empty()), () =>
						cleanupFailure ? Effect.die(new Error('private cleanup')) : Effect.void,
					),
				errors,
			})
			const registered = mutation({
				handler: (ctx) =>
					Effect.gen(function* () {
						yield* Effect.promise(() => ctx.db.insert('writes', { kind: 'domain' }))
						return yield* Effect.fail(errors.create('DENIED', {}))
					}),
			})
			try {
				await t.mutation((ctx) => invoke<Host, {}, never>(registered, ctx, {}))
				throw new Error('Expected rejection')
			} catch (error) {
				expect(error).toBeInstanceOf(ConvexError)
				if (!(error instanceof ConvexError)) throw error
				expect(error.data).toEqual(
					cleanupFailure
						? { _tag: 'UnknownFailure', version: 1 }
						: {
								_tag: 'DeclaredFailure',
								version: 1,
								code: 'DENIED',
								message: 'Access denied',
								details: {},
							},
				)
				expect(error.cause).toBeUndefined()
			}
			expect(await t.query((ctx) => ctx.db.query('writes').collect())).toEqual([])
		}
	})
	it('keeps registration options and executes ordinary, gen, fn and bare callbacks', async () => {
		const query = effectApiBuilder(queryGeneric, {
			services: () => Context.make(Request, { value: 7 }),
		})
		const ordinary = query({
			args: { name: v.string() },
			returns: v.number(),
			handler: (_ctx, args) => args.name.length,
		})
		const generated = query({ handler: () => Effect.map(Request, ({ value }) => value) })
		const fn = query({
			handler: Effect.fn(function* () {
				return (yield* Request).value
			}),
		})
		const bare = query(() => Promise.resolve(8))
		expect(await invoke(ordinary, {}, { name: 'yes' })).toBe(3)
		expect(await invoke(generated, {}, {})).toBe(7)
		expect(await invoke(fn, {}, {})).toBe(7)
		expect(await invoke(bare, {}, {})).toBe(8)
		expect(ordinary.isQuery).toBe(true)
		expect(ordinary.isPublic).toBe(true)
		// SAFETY: Convex native registration retains these runtime validator exports.
		const registration = ordinary as typeof ordinary & {
			exportArgs: () => string
			exportReturns: () => string
		}
		expect(registration.exportArgs()).toContain('name')
		expect(registration.exportReturns()).toContain('number')
		const internal = effectApiBuilder(internalMutationGeneric, { services: () => Context.empty() })(
			() => 1,
		)
		const action = effectApiBuilder(actionGeneric, { services: () => Context.empty() })(() => 2)
		expect(internal.isInternal).toBe(true)
		expect(internal.isMutation).toBe(true)
		expect(action.isAction).toBe(true)
		expect(await invoke(internal, {}, {})).toBe(1)
		expect(await invoke(action, {}, {})).toBe(2)
	})

	it('owns scoped cleanup before both successful and failed completion', async () => {
		for (const failure of [false, true]) {
			const events: string[] = []
			const query = effectApiBuilder(queryGeneric, {
				services: () =>
					Effect.acquireRelease(
						Effect.sync(() => {
							events.push('acquire')
							return Context.make(Request, { value: 3 })
						}),
						() =>
							Effect.promise(async () => {
								await Promise.resolve()
								events.push('release')
							}),
					),
			})
			const registered = query({
				handler: () =>
					Effect.gen(function* () {
						events.push(`handle:${(yield* Request).value}`)
						if (failure) return yield* Effect.fail('expected')
						return 3
					}),
			})
			const pending = invoke(registered, {}, {})
			if (failure) await expect(pending).rejects.toBe('expected')
			else expect(await pending).toBe(3)
			expect(events).toEqual(['acquire', 'handle:3', 'release'])
		}
	})

	it('constructs and releases isolated services for concurrent invocations', async () => {
		const released: string[] = []
		const query = effectApiBuilder(queryGeneric, {
			services: (ctx) =>
				Effect.acquireRelease(
					Effect.promise(async () =>
						Context.make(Request, { value: (await ctx.auth.getUserIdentity())!.name!.length }),
					),
					(context) =>
						Effect.sync(() => {
							released.push(String(Context.get(context, Request).value))
						}),
				),
		})
		const registered = query({
			handler: () =>
				Effect.gen(function* () {
					const request = yield* Request
					yield* Effect.promise(async () => {
						await Promise.resolve()
					})
					return request.value
				}),
		})
		const host = (name: string) => ({ auth: { getUserIdentity: async () => ({ name }) } })
		expect(
			await Promise.all([invoke(registered, host('a'), {}), invoke(registered, host('abc'), {})]),
		).toEqual([1, 3])
		expect(released.sort()).toEqual(['1', '3'])
	})

	it('retains singular failures and defects, and wraps interruption and full composite causes', async () => {
		const expected = { code: 'expected' }
		const defect = Error('defect')
		const composite = Cause.combine(Cause.fail(expected), Cause.die(defect))
		const query = effectApiBuilder(queryGeneric, { services: () => Context.empty() })
		await expect(
			invoke(
				query(() => Effect.fail(expected)),
				{},
				{},
			),
		).rejects.toBe(expected)
		await expect(
			invoke(
				query(() => Effect.die(defect)),
				{},
				{},
			),
		).rejects.toBe(defect)
		await expect(
			invoke(
				query(() => {
					throw defect
				}),
				{},
				{},
			),
		).rejects.toBe(defect)
		await expect(
			invoke(
				query(() => Promise.reject(defect)),
				{},
				{},
			),
		).rejects.toBe(defect)
		for (const cause of [Cause.interrupt(1), composite]) {
			try {
				await invoke(
					query(() => Effect.failCause(cause)),
					{},
					{},
				)
				throw Error('expected rejection')
			} catch (error) {
				if (!(error instanceof Error)) throw error
				expect(error.message).toBe('Effect API execution failed')
				expect(error.cause).toEqual(cause)
			}
		}
	})

	it('rejects projected errors after writes, rolling the mutation back', async () => {
		const t = convexTest(schema, modules)
		const mutation = effectApiBuilder(nativeMutation, {
			services: () => Context.empty(),
			mapError: () => new ConvexError('SAFE'),
		})
		const registered = mutation({
			handler: (ctx) =>
				Effect.gen(function* () {
					yield* Effect.promise(() => ctx.db.insert('writes', { kind: 'domain' }))
					return yield* Effect.fail('private detail')
				}),
		})
		await expect(t.mutation((ctx) => invoke<Host, {}, never>(registered, ctx, {}))).rejects.toThrow(
			'SAFE',
		)
		expect(await t.query((ctx) => ctx.db.query('writes').collect())).toEqual([])
	})

	it('rolls back writes when scoped cleanup fails after handler success', async () => {
		const t = convexTest(schema, modules)
		const defect = Error('release failed')
		const mutation = effectApiBuilder(nativeMutation, {
			services: () =>
				Effect.acquireRelease(Effect.succeed(Context.empty()), () => Effect.die(defect)),
		})
		const registered = mutation({
			handler: (ctx) => Effect.promise(() => ctx.db.insert('writes', { kind: 'domain' })),
		})
		await expect(
			t.mutation((ctx) => invoke<Host, {}, unknown>(registered, ctx, {})),
		).rejects.toThrow('release failed')
		expect(await t.query((ctx) => ctx.db.query('writes').collect())).toEqual([])
	})

	it('preserves a handler failure together with failed cleanup without projecting one constituent', async () => {
		const expected = { code: 'expected' }
		const defect = Error('release failed')
		let projections = 0
		const query = effectApiBuilder(queryGeneric, {
			services: () =>
				Effect.acquireRelease(Effect.succeed(Context.empty()), () => Effect.die(defect)),
			mapError: () => {
				projections++
				return new ConvexError('SAFE')
			},
		})
		try {
			await invoke(
				query(() => Effect.fail(expected)),
				{},
				{},
			)
			throw Error('expected rejection')
		} catch (error) {
			expect(error).toBeInstanceOf(Error)
			if (!(error instanceof Error) || !Cause.isCause(error.cause)) throw error
			expect(error.message).toBe('Effect API execution failed')
			expect(
				error.cause.reasons.some(
					(reason) => Cause.isFailReason(reason) && reason.error === expected,
				),
			).toBe(true)
			expect(
				error.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect),
			).toBe(true)
		}
		expect(projections).toBe(0)
	})
})

it('binds commands in a native helper once and exposes two-argument execution', async () => {
	const { createEffectFoundation } = await import('../src/effect')
	const { z } = await import('zod')
	const foundation = createEffectFoundation({
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
		},
		writeAudit: () => undefined,
	})
	const commands = foundation.Command({
		context: (value: number) => ({ value }),
		operations: ({ command }) => ({
			add: command({
				input: z.number(),
				result: z.number(),
				classification: 'business',
				audit: () => null,
				handler: (input, ctx) => input + ctx.value,
			}),
		}),
	})
	const query = effectApiBuilder(queryGeneric, {
		context: () => ({ commands: commands.withContext(42) }),
	})
	const load = query({
		args: { value: v.number() },
		handler: (ctx, input) => ctx.commands.exec('add', input.value),
	})
	const t = convexTest(schema, {
		'./_generated/server.ts': async () => ({}),
		'./functions.ts': async () => ({ load }),
	})
	expect(
		await t.query(makeFunctionReference<'query', { value: number }, number>('functions:load'), {
			value: 8,
		}),
	).toBe(50)
})

it('preserves context prototypes and non-enumerable fields when extending context', async () => {
	const { wrapEffectBuilder } = await import('../src/modules/effect/api-runtime')
	const prototype = { actor: 'trusted' }
	const context = Object.create(prototype, { db: { value: 'secured', enumerable: false } })
	const builder = wrapEffectBuilder((handler: (ctx: { actor: string; db: string }) => Promise<string>) => handler, {
		context: () => ({ extra: 'feature' }),
	})
	const handler = builder((ctx: { actor: string; db: string; extra: string }) => {
		expect(Object.getPrototypeOf(ctx)).toBe(prototype)
		expect(Object.getOwnPropertyDescriptor(ctx, 'db')?.enumerable).toBe(false)
		return Effect.succeed(`${ctx.actor}:${ctx.db}:${ctx.extra}`)
	})
	expect(await handler(context)).toBe('trusted:secured:feature')
	expect(Object.hasOwn(context, 'extra')).toBe(false)
})
