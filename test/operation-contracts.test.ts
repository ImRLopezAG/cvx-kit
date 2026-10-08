import { expect, it } from 'vite-plus/test'
import { Context, Effect, Schema, SchemaGetter } from 'effect'
import { convexTest } from 'convex-test'
import { defineSchema, defineTable, makeFunctionReference, mutationGeneric } from 'convex/server'
import { v } from 'convex/values'
import { z } from 'zod'
import {
	decodeContract,
	operationContract,
	standardContract,
	zodContract,
	convexContract,
	type StandardSchema,
} from '../src/contracts'
import { decodeEffectContract, effectSchema } from '../src/modules/effect/schema'

it('awaits async normalization once and keeps final replay and wire independent', async () => {
	let calls = 0
	const input = zodContract(
		z.string().transform(async (title) => {
			calls++
			await Promise.resolve()
			return title.trim()
		}),
	)
	const contract = operationContract({
		input,
		result: z.number().transform((count) => ({ count })),
		replayResult: zodContract(z.object({ count: z.number() })),
		wire: { project: (result: { count: number }) => String(result.count), schema: z.string() },
	})
	expect(await decodeContract(contract.input, ' title ')).toEqual({ value: 'title' })
	expect(calls).toBe(1)
	const standard = standardContract({
		'~standard': {
			version: 1 as const,
			vendor: 'async',
			validate: async (value) => ({ value: String(value).trim() }),
		},
	})
	expect(await decodeContract(standard, ' title ')).toEqual({ value: 'title' })
	expect(await decodeContract(contract.result, 2)).toEqual({ value: { count: 2 } })
	expect(await decodeContract(contract.replayResult, { count: 2 })).toEqual({ value: { count: 2 } })
	expect((await decodeContract(contract.replayResult, 2)).issues).toBeDefined()
	expect(await decodeContract(contract.wire.schema, contract.wire.project({ count: 2 }))).toEqual({
		value: '2',
	})
})

it('preserves the Standard Schema validator receiver through adaptation', async () => {
	const schema: StandardSchema<string, string> = {
		'~standard': {
			version: 1,
			vendor: 'receiver-dependent',
			validate(value) {
				if (this.vendor !== 'receiver-dependent') return { issues: [{ message: 'lost receiver' }] }
				return { value: String(value) }
			},
		},
	}
	expect(await decodeContract(schema, 'ok')).toEqual({ value: 'ok' })
	expect(await decodeContract(standardContract(schema), 'ok')).toEqual({ value: 'ok' })
})

it('keeps validation issues separate from validator rejection defects', async () => {
	const failure = new Error('private validator rejection')
	const invalid = standardContract(z.string())
	expect((await decodeContract(invalid, 1)).issues).toBeDefined()
	const rejected = standardContract({
		'~standard': {
			version: 1 as const,
			vendor: 'test',
			validate: async () => {
				throw failure
			},
		},
	})
	await expect(decodeContract(rejected, 'x')).rejects.toBe(failure)
	const exit = await Effect.runPromiseExit(decodeEffectContract(rejected, 'x'))
	expect(exit._tag).toBe('Failure')
	if (exit._tag === 'Failure') expect(exit.cause.reasons[0]?._tag).toBe('Die')
})

it('retains native strictness, optional fields, and explicit validators', async () => {
	const validator = v.object({ title: v.string(), note: v.optional(v.string()) })
	const contract = convexContract(validator)
	expect(contract.nativeValidator).toBe(validator)
	expect(await decodeContract(contract, { title: 'ok' })).toEqual({ value: { title: 'ok' } })
	expect((await decodeContract(contract, { title: 'ok', extra: true })).issues).toBeDefined()
})

it('decodes and encodes explicit Effect 4 codecs independently', async () => {
	const codec = effectSchema(Schema.Number)
	expect(await Effect.runPromise(decodeEffectContract(codec, 3))).toBe(3)
	expect(await Effect.runPromise(codec.encode(3))).toBe(3)
	const exit = await Effect.runPromiseExit(decodeEffectContract(codec, 'bad'))
	expect(exit._tag).toBe('Failure')
	if (exit._tag === 'Failure') expect(exit.cause.reasons[0]?._tag).toBe('Fail')
})

it('provisions decoding and encoding services separately for Effect schema transforms', async () => {
	class DecoderService extends Context.Service<DecoderService, string>()('DecoderService') {}
	class EncoderService extends Context.Service<EncoderService, number>()('EncoderService') {}
	const schema = Schema.Number.pipe(
		Schema.decodeTo(Schema.String, {
			decode: SchemaGetter.transformEffect((number) =>
				DecoderService.pipe(Effect.map((prefix) => `${prefix}${number}`)),
			),
			encode: SchemaGetter.transformEffect((_text) => EncoderService),
		}),
	)
	const codec = effectSchema(schema)
	expect(
		await Effect.runPromise(
			decodeEffectContract(codec, 3).pipe(Effect.provideService(DecoderService, 'title:')),
		),
	).toBe('title:3')
	expect(
		await Effect.runPromise(codec.encode('title:3').pipe(Effect.provideService(EncoderService, 3))),
	).toBe(3)
})

it('rejects wrong-table IDs through the secured adapter and retained native registration', async () => {
	const schema = defineSchema({
		documents: defineTable({ title: v.string() }),
		users: defineTable({ name: v.string() }),
	})
	const contract = convexContract(v.object({ id: v.id('documents') }))
	const t = convexTest(schema, {
		'./_generated/api.js': async () => ({}),
		'./contracts.ts': async () => ({
			read: mutationGeneric({ args: contract.nativeValidator, handler: (_ctx, args) => args.id }),
		}),
	})
	const ids = await t.run(async ({ db }) => ({
		document: await db.insert('documents', { title: 'ok' }),
		user: await db.insert('users', { name: 'other' }),
	}))
	await t.run(async ({ db }) => {
		const secured = convexContract(contract.nativeValidator, { db })
		expect(await decodeContract(secured, { id: ids.document })).toEqual({
			value: { id: ids.document },
		})
		expect((await decodeContract(secured, { id: ids.user })).issues).toBeDefined()
	})
	const read = makeFunctionReference<'mutation'>('contracts:read')
	expect(await t.mutation(read, { id: ids.document })).toBe(ids.document)
	await expect(t.mutation(read, { id: ids.user })).rejects.toThrow()
})
