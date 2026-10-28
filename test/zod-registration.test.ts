import { asObjectValidator } from 'convex/values'
import { NoOp, type Customization } from 'convex-helpers/server/customFunctions'
import { zCustomQuery, zCustomMutation, zCustomAction, zid } from 'convex-helpers/server/zod4'
import {
	queryGeneric,
	mutationGeneric,
	actionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	internalActionGeneric,
	makeFunctionReference,
	defineSchema,
	type DefaultFunctionArgs,
	type GenericDataModel,
	type GenericQueryCtx,
} from 'convex/server'
import { ConvexError, v, type GenericValidator, type Value } from 'convex/values'
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import * as mini from 'zod/mini'
import { createAuthFunctions } from '../src/auth'
import {
	zCustomQuery as kitQuery,
	zCustomMutation as kitMutation,
	zCustomAction as kitAction,
} from '../src/zod-registration'

const implementations = [
	{
		name: 'installed helper',
		query: zCustomQuery,
		mutation: zCustomMutation,
		action: zCustomAction,
	},
	{ name: 'kit adapter', query: kitQuery, mutation: kitMutation, action: kitAction },
]
const schema = defineSchema({})
const modules = { './_generated/server.ts': async () => ({ query: queryGeneric }) }
function harness() {
	return convexTest(schema, modules)
}

function runtime(fn: { isConvexFunction: true }) {
	// SAFETY: native generated builders attach these runtime methods; Convex's public
	// declaration strips them. This test-only boundary also permits invalid raw input.
	return fn as {
		isConvexFunction: true
		exportArgs(): string
		exportReturns(): string
		_handler(
			ctx: GenericQueryCtx<GenericDataModel>,
			args: DefaultFunctionArgs,
		): Promise<Value | undefined>
	}
}

for (const impl of implementations) {
	describe(impl.name, () => {
		it('invokes actual public native query, mutation and action registrations', async () => {
			const definition = {
				args: { value: z.string().transform(Number) },
				returns: z.number().transform((value) => ({ value })),
				handler: (
					_ctx:
						| GenericQueryCtx<GenericDataModel>
						| import('convex/server').GenericMutationCtx<GenericDataModel>
						| import('convex/server').GenericActionCtx<GenericDataModel>,
					args: { value: number },
				) => args.value,
			}
			const functions = {
				query: impl.query(queryGeneric, NoOp)(definition),
				mutation: impl.mutation(mutationGeneric, NoOp)(definition),
				action: impl.action(actionGeneric, NoOp)(definition),
			}
			const t = convexTest(schema, { ...modules, './functions.ts': async () => functions })
			const query = makeFunctionReference<'query', { value: string }, { value: number }>(
				'functions:query',
			)
			const mutation = makeFunctionReference<'mutation', { value: string }, { value: number }>(
				'functions:mutation',
			)
			const action = makeFunctionReference<'action', { value: string }, { value: number }>(
				'functions:action',
			)
			expect(await t.query(query, { value: '42' })).toEqual({ value: 42 })
			expect(await t.mutation(mutation, { value: '43' })).toEqual({ value: 43 })
			expect(await t.action(action, { value: '44' })).toEqual({ value: 44 })
		})

		it('converts return validators before argument registration and the no-args skip guard', () => {
			const builder = impl.query(queryGeneric, {
				args: { token: v.string() },
				input: () => ({ ctx: {}, args: {} }),
			})
			expect(() => {
				// @ts-expect-error invalid input schema probes the registration error ordering
				return builder({ args: z.string(), returns: z.date(), handler: () => new Date() })
			}).toThrow('Validator ZodDate is not supported in Convex')
			expect(() => builder({ returns: z.date(), handler: () => new Date() })).toThrow(
				'Validator ZodDate is not supported in Convex',
			)
			// Skipping omits return conversion, so the original customization guard wins.
			expect(() =>
				builder({ returns: z.date(), skipConvexValidation: true, handler: () => new Date() }),
			).toThrow('you cannot skip convex validation')
		})

		it.each([true, false])(
			'keeps return refinements and hook failures in both argument branches: %s',
			async (withArgs) => {
				const events: string[] = []
				const builder = impl.query(queryGeneric, {
					args: {},
					input: () => ({
						ctx: {},
						args: {},
						onSuccess: () => {
							events.push('success')
							throw new Error('hook failure')
						},
					}),
				})
				const fn = builder({
					args: withArgs ? {} : undefined,
					returns: z
						.number()
						.refine(async (n) => {
							events.push('return')
							return n > 0
						})
						.transform((n) => n + 1),
					handler: () => 1,
				})
				await expect(harness().run((ctx) => runtime(fn)._handler(ctx, {}))).rejects.toThrow(
					'hook failure',
				)
				expect(events).toEqual(['return', 'success'])
			},
		)
		it('parses async input, transforms/defaults, and picks only user fields', async () => {
			const events: string[] = []
			const builder = impl.query(queryGeneric, {
				args: {},
				input: () => {
					events.push('input')
					return { ctx: {}, args: {} }
				},
			})
			const fn = builder({
				args: z.object({
					text: z
						.string()
						.refine(async (text) => {
							events.push('refine')
							return text !== 'bad'
						})
						.transform((text) => text.length),
					count: z.number().default(7),
					optional: z.string().optional(),
				}),
				handler: (_, args) => {
					events.push('handler')
					return args
				},
			})
			expect(
				await harness().run((ctx) => runtime(fn)._handler(ctx, { text: 'four', ignored: true })),
			).toEqual({ text: 4, count: 7 })
			expect(events).toEqual(['input', 'refine', 'handler'])
			events.length = 0
			const error = await harness()
				.run((ctx) => runtime(fn)._handler(ctx, { text: 'bad' }))
				.catch((error: Error) => error)
			expect(error).toBeInstanceOf(ConvexError)
			expect(error).toMatchObject({
				data: { ZodError: [{ code: 'custom', path: ['text'], message: 'Invalid input' }] },
			})
			expect(events).toEqual(['input', 'refine'])
		})

		it.each(['object', 'shape'] as const)(
			'reparses %s arguments and runs defaults/refinements on every invocation',
			async (kind) => {
				let defaults = 0
				const refined: string[] = []
				const args = z.object({
					text: z
						.string()
						.refine(async (text) => {
							refined.push(text)
							return text !== 'bad'
						})
						.transform((text) => text.length),
					count: z.number().default(() => ++defaults),
				})
				const fn = impl.query(
					queryGeneric,
					NoOp,
				)({
					args: kind === 'object' ? args : args.shape,
					handler: (_, parsed) => parsed,
				})
				for (const [text, count] of [
					['one', 1],
					['longer', 2],
				] as const) {
					expect(await harness().run((ctx) => runtime(fn)._handler(ctx, { text }))).toEqual({
						text: text.length,
						count,
					})
				}
				await expect(
					harness().run((ctx) => runtime(fn)._handler(ctx, { text: 'bad' })),
				).rejects.toMatchObject({
					data: { ZodError: [{ code: 'custom', path: ['text'], message: 'Invalid input' }] },
				})
				expect(refined).toEqual(['one', 'longer', 'bad'])
				expect(defaults).toBe(3)
			},
		)

		it.each([
			mini.object({ text: mini.string(), optional: mini.optional(mini.number()) }),
			{ text: mini.string(), optional: mini.optional(mini.number()) },
		])('accepts Mini object and field maps', async (args) => {
			const fn = impl.query(queryGeneric, NoOp)({ args, handler: (_, parsed) => parsed })
			expect(await harness().run((ctx) => runtime(fn)._handler(ctx, { text: 'mini' }))).toEqual({
				text: 'mini',
			})
			expect(JSON.parse(runtime(fn).exportArgs())).toEqual({
				type: 'object',
				value: {
					text: { fieldType: { type: 'string' }, optional: false },
					optional: { fieldType: { type: 'number' }, optional: true },
				},
			})
		})

		it('preserves customization inputs, extra options, merge precedence and success hook inputs', async () => {
			const events: string[] = []
			let nativeCtx: GenericQueryCtx<GenericDataModel> | undefined
			const customization: Customization<
				GenericQueryCtx<GenericDataModel>,
				{ token: ReturnType<typeof v.string> },
				{ auth: 'patched' },
				{ text: number; added: boolean },
				{ label: string }
			> = {
				args: { token: v.string() },
				input: (ctx, args, extra) => {
					events.push('input')
					expect(ctx).toBe(nativeCtx)
					expect(args).toEqual({ token: 'secret' })
					expect(extra).toEqual({ label: 'extra' })
					return {
						ctx: { auth: 'patched' },
						args: { text: 99, added: true },
						onSuccess: ({ ctx, args, result }) => {
							events.push('success')
							expect(ctx).toBe(nativeCtx)
							expect(args).toEqual({ text: 4 })
							expect(result).toBe('value:99')
						},
					}
				},
			}
			const fn = impl.query(
				queryGeneric,
				customization,
			)({
				label: 'extra',
				args: { text: z.string().transform((text) => text.length) },
				returns: z.number().transform((number) => {
					events.push('return')
					return `value:${number}`
				}),
				handler: (ctx, args) => {
					events.push('handler')
					expect(ctx.auth).toBe('patched')
					expect(args).toEqual({ text: 99, added: true })
					return args.text
				},
			})
			expect(
				await harness().run((ctx) => {
					nativeCtx = ctx
					return runtime(fn)._handler(ctx, { text: 'four', token: 'secret' })
				}),
			).toBe('value:99')
			expect(events).toEqual(['input', 'handler', 'return', 'success'])
			expect(JSON.parse(runtime(fn).exportReturns())).toEqual({ type: 'any' })
		})

		it('runs customization before invalid input and never runs success after failures', async () => {
			const events: string[] = []
			const builder = impl.query(queryGeneric, {
				args: {},
				input: () => {
					events.push('input')
					return {
						ctx: {},
						args: {},
						onSuccess: () => {
							events.push('success')
						},
					}
				},
			})
			const fn = builder({
				args: { value: z.number() },
				returns: z.number().refine(async (n) => n > 0),
				handler: (_, args) => {
					events.push('handler')
					if (args.value === 0) throw new Error('handler failure')
					return args.value
				},
			})
			await expect(
				harness().run((ctx) => runtime(fn)._handler(ctx, { value: 'invalid' })),
			).rejects.toBeInstanceOf(ConvexError)
			expect(events).toEqual(['input'])
			events.length = 0
			await expect(harness().run((ctx) => runtime(fn)._handler(ctx, { value: 0 }))).rejects.toThrow(
				'handler failure',
			)
			expect(events).toEqual(['input', 'handler'])
			events.length = 0
			await expect(
				harness().run((ctx) => runtime(fn)._handler(ctx, { value: -1 })),
			).rejects.toBeInstanceOf(z.ZodError)
			expect(events).toEqual(['input', 'handler'])
			const denied = impl.query(queryGeneric, {
				args: {},
				input: () => {
					throw new Error('customization denial')
				},
			})({ args: { value: z.number() }, handler: () => null })
			await expect(
				harness().run((ctx) => runtime(denied)._handler(ctx, { value: 'invalid' })),
			).rejects.toThrow('customization denial')
		})

		it('normalizes return field maps and undefined only when parsing returns', async () => {
			const builder = impl.query(queryGeneric, NoOp)
			const map = builder({
				args: {},
				returns: { value: z.string().transform((s) => s.length) },
				handler: () => ({ value: 'four', ignored: true }),
			})
			expect(await harness().run((ctx) => runtime(map)._handler(ctx, {}))).toEqual({ value: 4 })
			const normalized = builder({ returns: z.null(), handler: () => undefined })
			expect(await harness().run((ctx) => runtime(normalized)._handler(ctx, {}))).toBeNull()
			const untouched = builder({ handler: () => undefined })
			await harness().run(async (ctx) => {
				expect(await runtime(untouched)._handler(ctx, {})).toBeUndefined()
			})
		})

		it('preserves no-args and shorthand raw arguments, extra options and hooks', async () => {
			const seen: object[] = []
			const builder = impl.query(queryGeneric, {
				args: { token: v.string() },
				input: (_ctx, args, extra) => {
					seen.push({ args, extra })
					return {
						ctx: {},
						args: { added: true },
						onSuccess: ({ args, result }) => {
							seen.push({ args, result })
						},
					}
				},
			})
			const fn = builder({ handler: (_, args) => args })
			const raw = { token: 'secret', free: 42 }
			expect(await harness().run((ctx) => runtime(fn)._handler(ctx, raw))).toEqual({
				...raw,
				added: true,
			})
			expect(seen).toEqual([
				{ args: raw, extra: {} },
				{ args: raw, result: { ...raw, added: true } },
			])
			expect(JSON.parse(runtime(fn).exportArgs())).toEqual({ type: 'any' })
			const shorthand = impl.query(queryGeneric, NoOp)((_ctx) => 'shorthand')
			expect(await harness().run((ctx) => runtime(shorthand)._handler(ctx, {}))).toBe('shorthand')
		})

		it('preserves skip behavior, converter execution and exact no-args guard', async () => {
			const builder = impl.query(queryGeneric, {
				args: { token: v.string() },
				input: () => ({ ctx: {}, args: {} }),
			})
			expect(() => builder({ skipConvexValidation: true, handler: () => null })).toThrow(
				"If you're using a custom function with arguments for the input customization, you cannot skip convex validation.",
			)
			const fn = builder({
				args: { text: z.string().transform((s) => s.length) },
				skipConvexValidation: true,
				returns: z.number().transform((n) => `${n}`),
				handler: (_, args) => args.text,
			})
			expect(JSON.parse(runtime(fn).exportArgs())).toEqual({ type: 'any' })
			expect(JSON.parse(runtime(fn).exportReturns())).toBeNull()
			expect(
				await harness().run((ctx) => runtime(fn)._handler(ctx, { text: 'four', token: 'secret' })),
			).toBe('4')
			expect(() =>
				builder({ args: { date: z.date() }, skipConvexValidation: true, handler: () => null }),
			).toThrow('Validator ZodDate is not supported in Convex')
			const noArgs = impl.query(
				queryGeneric,
				NoOp,
			)({ skipConvexValidation: true, returns: z.null(), handler: () => undefined })
			expect(await harness().run((ctx) => runtime(noArgs)._handler(ctx, {}))).toBeNull()
		})

		it('preserves overlapping native argument intersection and unsupported object errors', () => {
			const builder = impl.query(queryGeneric, {
				args: { value: v.string() },
				input: () => ({ ctx: {}, args: {} }),
			})
			expect(() => builder({ args: { value: z.number() }, handler: () => null })).toThrow(
				'Cannot intersect validators with different kinds: float64 and string',
			)
			const fn = builder({ args: { value: z.string().optional() }, handler: () => null })
			expect(JSON.parse(runtime(fn).exportArgs()).value.value.optional).toBe(false)
			for (const args of [z.string(), mini.string()]) {
				expect(() => {
					// @ts-expect-error runtime rejection of nonobject argument schemas
					return builder({ args, handler: () => null })
				}).toThrow(`Unsupported zod type as args validator: ${args.constructor.name}`)
			}
		})

		it('registers native metadata and visibility for all query/mutation/action families', () => {
			const args = {
				id: zid('tasks'),
				nested: z.object({ list: z.array(z.union([z.string(), z.null()])) }).optional(),
			}
			const functions = [
				impl.query(queryGeneric, NoOp)({ args, returns: z.null(), handler: () => null }),
				impl.query(internalQueryGeneric, NoOp)({ args, returns: z.null(), handler: () => null }),
				impl.mutation(mutationGeneric, NoOp)({ args, returns: z.null(), handler: () => null }),
				impl.mutation(
					internalMutationGeneric,
					NoOp,
				)({ args, returns: z.null(), handler: () => null }),
				impl.action(actionGeneric, NoOp)({ args, returns: z.null(), handler: () => null }),
				impl.action(internalActionGeneric, NoOp)({ args, returns: z.null(), handler: () => null }),
			]
			for (const [index, fn] of functions.entries()) {
				expect(JSON.parse(runtime(fn).exportArgs()).value.id).toEqual({
					fieldType: { type: 'id', tableName: 'tasks' },
					optional: false,
				})
				expect(runtime(fn).exportArgs()).toBe(runtime(functions[0]).exportArgs())
				expect(JSON.parse(runtime(fn).exportReturns())).toEqual({ type: 'null' })
				expect('isPublic' in fn).toBe(index % 2 === 0)
				expect('isInternal' in fn).toBe(index % 2 === 1)
			}
		})
	})
}

it('characterizes helper repeated native container expansion through registration', () => {
	let native: GenericValidator | undefined
	const captured: typeof queryGeneric = (definition) => {
		if ('args' in definition && definition.args) native = asObjectValidator(definition.args)
		return queryGeneric(definition)
	}
	const child = z.object({ id: zid('tasks') })
	zCustomQuery(captured, NoOp)({ args: { a: child, b: child }, handler: () => null })
	expect(native?.kind).toBe('object')
	if (native?.kind !== 'object') throw new Error('Missing native object validator')
	expect(native.fields.a).not.toBe(native.fields.b)
})

it('shares a repeated argument graph when composing native customization fields', () => {
	let native: GenericValidator | undefined
	const captured: typeof queryGeneric = (definition) => {
		if ('args' in definition && definition.args) native = asObjectValidator(definition.args)
		return queryGeneric(definition)
	}
	const leaf = z.object({ id: zid('tasks'), name: z.string() })
	const array = z.array(leaf)
	const union = z.union([leaf, array])
	const optional = union.optional()
	const args = Object.fromEntries(
		Array.from({ length: 64 }, (_, index) => [`branch${index}`, optional]),
	)
	const customization = { args: { token: v.id('sessions') }, input: () => ({ ctx: {}, args: {} }) }
	const old = zCustomQuery(queryGeneric, customization)({ args, handler: () => null })
	const actual = kitQuery(captured, customization)({ args, handler: () => null })
	expect(runtime(actual).exportArgs()).toBe(runtime(old).exportArgs())
	if (native?.kind !== 'object') throw new Error('Missing native object validator')
	for (let index = 1; index < 64; index++)
		expect(native.fields[`branch${index}`]).toBe(native.fields.branch0)
	expect(native.fields.token.kind).toBe('id')
	expect(JSON.parse(runtime(actual).exportArgs()).value.token).toEqual({
		fieldType: { type: 'id', tableName: 'sessions' },
		optional: false,
	})
})

it('shares repeated public native argument containers through every auth query constructor', () => {
	const captured: GenericValidator[] = []
	const nativeQuery: typeof queryGeneric = (definition) => {
		if ('args' in definition && definition.args) captured.push(asObjectValidator(definition.args))
		return queryGeneric(definition)
	}
	const nativeInternalQuery: typeof internalQueryGeneric = (definition) => {
		if ('args' in definition && definition.args) captured.push(asObjectValidator(definition.args))
		return internalQueryGeneric(definition)
	}
	const auth = createAuthFunctions({
		query: nativeQuery,
		internalQuery: nativeInternalQuery,
		mutation: mutationGeneric,
		internalMutation: internalMutationGeneric,
		action: actionGeneric,
		internalAction: internalActionGeneric,
		getAuthUser: async () => ({ id: 'user' }),
		mapRole: () => 'owner',
		adminRoles: ['owner'],
	})
	const child = z.object({ id: zid('tasks'), text: z.string() })
	const array = z.array(child)
	const union = z.union([child, array])
	const optional = union.optional()
	const args = {
		a: child,
		b: child,
		c: array,
		d: array,
		e: union,
		f: union,
		g: optional,
		h: optional,
	}
	const old = zCustomQuery(queryGeneric, NoOp)({ args, handler: () => null })
	for (const builder of [
		auth.authQuery,
		auth.roleQuery('owner'),
		auth.adminQuery,
		auth.systemQuery,
	]) {
		const fn = builder({ args, handler: () => null })
		expect(runtime(fn).exportArgs()).toBe(runtime(old).exportArgs())
	}
	expect(captured).toHaveLength(4)
	for (const native of captured) {
		if (native.kind !== 'object') throw new Error('Missing native object validator')
		for (const [a, b] of [
			['a', 'b'],
			['c', 'd'],
			['e', 'f'],
			['g', 'h'],
		])
			expect(native.fields[a]).toBe(native.fields[b])
	}
})

interface MutableArgumentFields {
	[field: string]: z.ZodType
}

// Capturing keys at registration intentionally tightens the helper's dynamic shape behavior.
it.each(['object', 'shape'] as const)(
	'captures %s argument fields without freezing nested validators',
	async (kind) => {
		const check = z.string().refine(() => true)
		const argumentFields: MutableArgumentFields = { value: check }
		const args = z.object(argumentFields)
		const fn = kitQuery(
			queryGeneric,
			NoOp,
		)({
			args: kind === 'object' ? args : argumentFields,
			handler: (_, parsed) => parsed,
		})
		const native = runtime(fn).exportArgs()
		const liveArgumentFields = kind === 'object' ? args.shape : argumentFields
		liveArgumentFields.later = z.string()
		liveArgumentFields.value = z.number()
		expect(
			await harness().run((ctx) =>
				runtime(fn)._handler(ctx, { value: 'original', later: 'extra' }),
			),
		).toEqual({ value: 'original' })
		// Deliberately mutate the original nested check: the wrapper must retain its identity.
		check._zod.def.checks![0]._zod.check = (payload) => {
			payload.issues.push({ code: 'custom', input: payload.value, message: 'changed nested check' })
		}
		await expect(
			harness().run((ctx) => runtime(fn)._handler(ctx, { value: 'original' })),
		).rejects.toMatchObject({
			data: { ZodError: [{ code: 'custom', path: ['value'], message: 'changed nested check' }] },
		})
		expect(runtime(fn).exportArgs()).toBe(native)
		expect(Object.isFrozen(argumentFields)).toBe(false)
		expect(Object.isFrozen(check)).toBe(false)
	},
)
