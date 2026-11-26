import { NoOp } from 'convex-helpers/server/customFunctions'
import {
	actionGeneric,
	defineSchema,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	makeFunctionReference,
	mutationGeneric,
	queryGeneric,
	type DefaultFunctionArgs,
	type GenericDataModel,
	type GenericQueryCtx,
} from 'convex/server'
import { ConvexError, v, type Value } from 'convex/values'
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vite-plus/test'
import { k } from '../src/k'
import { hasDeclaredBehaviour } from '../src/k/parse'
import {
	kCustomAction,
	kCustomMutation,
	kCustomQuery,
	rawFunctionArgs,
} from '../src/registration'

const schema = defineSchema({})
const modules = { './_generated/server.ts': async () => ({}) }

function harness() {
	return convexTest(schema, modules)
}

function runtime(fn: { isConvexFunction: true }) {
	// SAFETY: native builders attach these runtime methods; Convex's public declaration strips them.
	// This test-only boundary also permits structurally invalid raw input.
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

function call(fn: { isConvexFunction: true }, args: DefaultFunctionArgs) {
	return harness().run((ctx) => runtime(fn)._handler(ctx, args))
}

async function failure(promise: Promise<unknown>) {
	const error = await promise.then(
		() => undefined,
		(cause: Error) => cause,
	)
	expect(error).toBeInstanceOf(ConvexError)
	return error
}

const query = kCustomQuery(queryGeneric, NoOp)

describe('function boundary: declared behaviour only (KTD3, R19)', () => {
	it('AE4: runs no validation work for structural-only args', async () => {
		const args = { id: k.id('documents') }
		expect(hasDeclaredBehaviour(k.object(args))).toBe(false)
		let reads = 0
		let received: DefaultFunctionArgs | undefined
		const fn = query({
			args,
			handler: (_ctx, parsed) => {
				received = parsed
				return null
			},
		})
		// A structurally invalid id: any parse would reject it, and every trap counts a read.
		const raw = new Proxy<DefaultFunctionArgs>(
			{ id: 42 },
			{
				get: (target, key) => {
					reads++
					return Object.getOwnPropertyDescriptor(target, key)?.value
				},
				has: (target, key) => {
					reads++
					return Reflect.has(target, key)
				},
				ownKeys: (target) => {
					reads++
					return Reflect.ownKeys(target)
				},
				getOwnPropertyDescriptor: (target, key) => {
					reads++
					return Reflect.getOwnPropertyDescriptor(target, key)
				},
			},
		)
		for (let attempt = 0; attempt < 2; attempt++) {
			await call(fn, raw)
			expect(received).toBe(raw)
			expect(reads).toBe(0)
		}
	})

	it('passes trimmed and defaulted args to the handler', async () => {
		const fn = query({
			args: { name: k.string().trim().min(1), count: k.number().default(3) },
			handler: (_ctx, args) => args,
		})
		const t = convexTest(schema, { ...modules, './functions.ts': async () => ({ fn }) })
		const ref = makeFunctionReference<'query', { name: string; count?: number }>('functions:fn')
		expect(await t.query(ref, { name: '  ada ' })).toEqual({ name: 'ada', count: 3 })
		expect(await t.query(ref, { name: 'x', count: 9 })).toEqual({ name: 'x', count: 9 })
	})

	it('throws the KTD6 error with the failing arg path', async () => {
		const fn = query({
			args: { name: k.string().trim().min(1), tags: k.array(k.string().min(2)) },
			handler: () => null,
		})
		const error = await failure(call(fn, { name: '   ', tags: ['ok', 'x'] }))
		expect(error).toMatchObject({
			data: {
				code: 'VALIDATION',
				issues: [
					{ path: ['name'], code: 'too_small', message: expect.any(String) },
					{ path: ['tags', 1], code: 'too_small', message: expect.any(String) },
				],
			},
		})
		const t = convexTest(schema, { ...modules, './functions.ts': async () => ({ fn }) })
		await expect(
			t.query(makeFunctionReference<'query'>('functions:fn'), { name: '', tags: [] }),
		).rejects.toMatchObject({ data: { code: 'VALIDATION', issues: [{ path: ['name'] }] } })
	})

	it('treats a field object and a k.object the same', async () => {
		const fields = { name: k.string().trim().min(1), count: k.number().default(1) }
		const forms = [
			query({ args: fields, handler: (_ctx, args) => args }),
			query({ args: k.object(fields), handler: (_ctx, args) => args }),
		]
		for (const fn of forms) {
			expect(await call(fn, { name: ' a ' })).toEqual({ name: 'a', count: 1 })
			await expect(call(fn, { name: ' ' })).rejects.toMatchObject({
				data: { code: 'VALIDATION', issues: [{ path: ['name'] }] },
			})
		}
		expect(runtime(forms[0]).exportArgs()).toBe(runtime(forms[1]).exportArgs())
	})

	it('runs refinements declared on a k.object', async () => {
		const fn = query({
			args: k
				.object({ from: k.number(), to: k.number() })
				.refine((range) => range.from <= range.to, { message: 'backwards', path: ['to'] }),
			handler: (_ctx, args) => args.to - args.from,
		})
		expect(await call(fn, { from: 1, to: 3 })).toBe(2)
		await expect(call(fn, { from: 3, to: 1 })).rejects.toMatchObject({
			data: { code: 'VALIDATION', issues: [{ path: ['to'], code: 'custom', message: 'backwards' }] },
		})
	})

	it('passes native args through untouched', async () => {
		let received: DefaultFunctionArgs | undefined
		const raw = { when: 1, label: '  spaced  ' }
		for (const args of [{ when: v.number(), label: v.string() }, v.object({ when: v.number(), label: v.string() })]) {
			const fn = query({
				args,
				handler: (_ctx, parsed) => {
					received = parsed
					return null
				},
			})
			await call(fn, raw)
			expect(received).toBe(raw)
		}
	})

	it('applies k fields and keeps native fields in a mixed field object', async () => {
		const fn = query({
			args: { name: k.string().trim(), raw: v.string(), size: k.number().default(2) },
			handler: (_ctx, args) => args,
		})
		expect(await call(fn, { name: ' a ', raw: ' b ' })).toEqual({ name: 'a', raw: ' b ', size: 2 })
		expect(JSON.parse(runtime(fn).exportArgs())).toEqual({
			type: 'object',
			value: {
				name: { fieldType: { type: 'string' }, optional: false },
				raw: { fieldType: { type: 'string' }, optional: false },
				size: { fieldType: { type: 'number' }, optional: true },
			},
		})
	})

	it('accepts the bare handler and the no-args definition', async () => {
		const bare = query(() => 'bare')
		const noArgs = query({ handler: (_ctx, args) => args })
		expect(await call(bare, {})).toBe('bare')
		expect(await call(noArgs, { free: 1 })).toEqual({ free: 1 })
		expect(JSON.parse(runtime(noArgs).exportArgs())).toEqual({ type: 'any' })
	})

	it('rejects args that are not an object at registration', () => {
		expect(() =>
			// @ts-expect-error a string schema is not an args object
			query({ args: k.string(), handler: () => null }),
		).toThrow('Unsupported args schema')
		expect(() =>
			// @ts-expect-error an optional object is not a required args object
			query({ args: k.object({}).optional(), handler: () => null }),
		).toThrow('Unsupported args schema')
		expect(() =>
			// @ts-expect-error a native string is not an args object
			query({ args: v.string(), handler: () => null }),
		).toThrow('Unsupported args validator')
		expect(() =>
			// @ts-expect-error a field must be a k schema or a native validator
			query({ args: { a: 'nope' }, handler: () => null }),
		).toThrow("Unsupported args field 'a'")
	})
})

describe('export to Convex', () => {
	const kArgs = {
		id: k.id('documents'),
		name: k.string().trim().min(1),
		count: k.number().default(1),
		tags: k.array(k.string()).optional(),
		kind: k.enum(['a', 'b']),
		nested: k.object({ x: k.number().nullable() }),
	}
	const nativeArgs = {
		id: v.id('documents'),
		name: v.string(),
		count: v.optional(v.number()),
		tags: v.optional(v.array(v.string())),
		kind: v.union(v.literal('a'), v.literal('b')),
		nested: v.object({ x: v.union(v.number(), v.null()) }),
	}

	it('pushes the same args and returns JSON as hand-written native validators', () => {
		const native = queryGeneric({
			args: nativeArgs,
			returns: v.object({ ok: v.boolean(), count: v.number() }),
			handler: () => ({ ok: true, count: 0 }),
		})
		const declared = [
			query({
				args: kArgs,
				returns: k.object({ ok: k.boolean(), count: k.number().default(0) }),
				handler: () => ({ ok: true, count: 0 }),
			}),
			query({
				args: k.object(kArgs),
				returns: k.object({ ok: k.boolean(), count: k.number().default(0) }),
				handler: () => ({ ok: true, count: 0 }),
			}),
		]
		for (const fn of declared) {
			expect(runtime(fn).exportArgs()).toBe(runtime(native).exportArgs())
			expect(runtime(fn).exportReturns()).toBe(runtime(native).exportReturns())
		}
	})

	it('exports a defaulted returns field as required and returns the handler result untouched', async () => {
		const result = { count: 5 }
		const fn = query({
			returns: k.object({ count: k.number().min(10).default(0) }),
			handler: () => result,
		})
		expect(JSON.parse(runtime(fn).exportReturns())).toEqual({
			type: 'object',
			value: { count: { fieldType: { type: 'number' }, optional: false } },
		})
		// No return checks run in the kit: min(10) is not applied.
		await harness().run(async (ctx) => {
			expect(await runtime(fn)._handler(ctx, {})).toBe(result)
		})
	})

	it('rejects a transforming returns schema at export', () => {
		const fn = query({ returns: k.string().transform(Number), handler: () => 1 })
		expect(() => runtime(fn).exportReturns()).toThrow('A returns schema cannot transform')
	})

	it('builds no native validator until exportArgs or exportReturns is read', async () => {
		const name = k.string().trim()
		const count = k.number().default(1)
		const returns = k.object({ ok: k.boolean() })
		const fn = query({ args: { name, count }, returns, handler: () => ({ ok: true }) })
		const object = k.object({ id: k.id('documents') })
		const objectFn = query({ args: object, handler: () => null })
		// Calls do not build validators either.
		await call(fn, { name: ' a ' })
		await call(objectFn, { id: 'x' })
		expect([name.native, count.native, returns.native, returns.outputNative, object.native]).toEqual(
			[undefined, undefined, undefined, undefined, undefined],
		)
		runtime(fn).exportArgs()
		expect(name.native).toBeDefined()
		expect(count.native).toBeDefined()
		expect(returns.outputNative).toBeUndefined()
		runtime(fn).exportReturns()
		expect(returns.outputNative).toBeDefined()
		runtime(objectFn).exportArgs()
		expect(object.native).toBeDefined()
	})

	it('does not read getter-declared args or returns at registration', async () => {
		let reads = 0
		const fn = query({
			get args() {
				reads++
				return { name: k.string().trim() }
			},
			get returns() {
				reads++
				return k.string()
			},
			handler: (_ctx: GenericQueryCtx<GenericDataModel>, args: { name: string }) => args.name,
		})
		expect(reads).toBe(0)
		expect(await call(fn, { name: ' a ' })).toBe('a')
		expect(JSON.parse(runtime(fn).exportArgs()).value.name.fieldType).toEqual({ type: 'string' })
		expect(JSON.parse(runtime(fn).exportReturns())).toEqual({ type: 'string' })
		expect(reads).toBe(2)
	})

	it('registers native metadata and visibility for all function families', () => {
		const args = { id: k.id('tasks') }
		const functions = [
			kCustomQuery(queryGeneric, NoOp)({ args, returns: k.null(), handler: () => null }),
			kCustomQuery(internalQueryGeneric, NoOp)({ args, returns: k.null(), handler: () => null }),
			kCustomMutation(mutationGeneric, NoOp)({ args, returns: k.null(), handler: () => null }),
			kCustomMutation(internalMutationGeneric, NoOp)({
				args,
				returns: k.null(),
				handler: () => null,
			}),
			kCustomAction(actionGeneric, NoOp)({ args, returns: k.null(), handler: () => null }),
			kCustomAction(internalActionGeneric, NoOp)({ args, returns: k.null(), handler: () => null }),
		]
		for (const [index, fn] of functions.entries()) {
			expect(JSON.parse(runtime(fn).exportArgs()).value.id).toEqual({
				fieldType: { type: 'id', tableName: 'tasks' },
				optional: false,
			})
			expect(JSON.parse(runtime(fn).exportReturns())).toEqual({ type: 'null' })
			expect('isPublic' in fn).toBe(index % 2 === 0)
			expect('isInternal' in fn).toBe(index % 2 === 1)
		}
	})
})

describe('skipConvexValidation', () => {
	it('exports nothing and runs the full walker on args', async () => {
		const fn = query({
			args: { count: k.number(), name: k.string().trim() },
			returns: k.string(),
			skipConvexValidation: true,
			handler: (_ctx, args) => `${args.name}:${args.count}`,
		})
		expect(JSON.parse(runtime(fn).exportArgs())).toEqual({ type: 'any' })
		expect(JSON.parse(runtime(fn).exportReturns())).toBeNull()
		expect(await call(fn, { count: 1, name: ' a ' })).toBe('a:1')
		await expect(call(fn, { count: 'x', name: 'a' })).rejects.toMatchObject({
			data: { code: 'VALIDATION', issues: [{ path: ['count'], code: 'invalid_type' }] },
		})
		await expect(call(fn, { count: 1, name: 'a', extra: true })).rejects.toMatchObject({
			data: { code: 'VALIDATION', issues: [{ path: ['extra'], code: 'unrecognized_key' }] },
		})
	})

	it('checks native fields structurally too', async () => {
		const mixed = query({
			args: { name: k.string().trim(), when: v.number() },
			skipConvexValidation: true,
			handler: (_ctx, args) => args,
		})
		expect(await call(mixed, { name: ' a ', when: 1 })).toEqual({ name: 'a', when: 1 })
		await expect(call(mixed, { name: 1 })).rejects.toMatchObject({
			data: {
				code: 'VALIDATION',
				issues: expect.arrayContaining([
					{ path: ['when'], code: 'invalid_type', message: expect.any(String) },
					{ path: ['name'], code: 'invalid_type', message: expect.any(String) },
				]),
			},
		})
		const native = query({
			args: v.object({ when: v.number() }),
			skipConvexValidation: true,
			handler: () => null,
		})
		await expect(call(native, { when: 'x' })).rejects.toMatchObject({
			data: { code: 'VALIDATION', issues: [{ path: [], code: 'invalid_type' }] },
		})
	})

	it('keeps the customization-args guard', () => {
		const builder = kCustomQuery(queryGeneric, {
			args: { token: v.string() },
			input: () => ({ ctx: {}, args: {} }),
		})
		expect(() => builder({ skipConvexValidation: true, handler: () => null })).toThrow(
			'you cannot skip convex validation',
		)
	})
})

describe('customization', () => {
	it('merges customization args with declared args and feeds input its own args', async () => {
		const events: string[] = []
		const builder = kCustomQuery(queryGeneric, {
			args: { token: v.string() },
			input: (ctx, args, extra: { label: string }) => {
				events.push(`input:${JSON.stringify(args)}:${extra.label}`)
				expect(rawFunctionArgs(ctx)).toEqual({ token: 't', name: ' a ' })
				return {
					ctx: { who: args.token },
					args: { added: true },
					onSuccess: ({ args: parsed, result }) => {
						events.push(`success:${JSON.stringify(parsed)}:${String(result)}`)
					},
				}
			},
		})
		const fn = builder({
			label: 'extra',
			args: { name: k.string().trim() },
			handler: (ctx, args) => {
				events.push(`handler:${JSON.stringify(args)}`)
				return `${ctx.who}:${args.name}:${args.added}`
			},
		})
		expect(JSON.parse(runtime(fn).exportArgs())).toEqual({
			type: 'object',
			value: {
				name: { fieldType: { type: 'string' }, optional: false },
				token: { fieldType: { type: 'string' }, optional: false },
			},
		})
		const t = convexTest(schema, { ...modules, './functions.ts': async () => ({ fn }) })
		expect(
			await t.query(makeFunctionReference<'query'>('functions:fn'), { token: 't', name: ' a ' }),
		).toBe('t:a:true')
		expect(events).toEqual([
			'input:{"token":"t"}:extra',
			'handler:{"name":"a","added":true}',
			'success:{"name":"a"}:t:a:true',
		])
	})

	it('runs customization before args checks', async () => {
		const events: string[] = []
		const builder = kCustomQuery(queryGeneric, {
			args: {},
			input: () => {
				events.push('input')
				return { ctx: {}, args: {} }
			},
		})
		const fn = builder({
			args: {
				name: k.string().refine(() => {
					events.push('check')
					return false
				}),
			},
			handler: () => null,
		})
		await expect(call(fn, { name: 'a' })).rejects.toBeInstanceOf(ConvexError)
		expect(events).toEqual(['input', 'check'])
	})
})
