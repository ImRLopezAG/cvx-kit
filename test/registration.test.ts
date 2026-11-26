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
import { asObjectValidator, ConvexError, v, type GenericValidator, type Value } from 'convex/values'
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vite-plus/test'
import { createAuthFunctions } from '../src/auth'
import { k, type KType } from '../src/k'
import { hasDeclaredBehaviour } from '../src/k/parse'
import { kCustomAction, kCustomMutation, kCustomQuery, rawFunctionArgs } from '../src/registration'

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
			data: {
				code: 'VALIDATION',
				issues: [{ path: ['to'], code: 'custom', message: 'backwards' }],
			},
		})
	})

	it('passes native args through untouched', async () => {
		let received: DefaultFunctionArgs | undefined
		const raw = { when: 1, label: '  spaced  ' }
		for (const args of [
			{ when: v.number(), label: v.string() },
			v.object({ when: v.number(), label: v.string() }),
		]) {
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

	it('reuses scalar natives and builds no container validator until export', async () => {
		const name = k.string().trim()
		const count = k.number().default(1)
		const returns = k.object({ ok: k.boolean() })
		const fn = query({ args: { name, count }, returns, handler: () => ({ ok: true }) })
		const object = k.object({ id: k.id('documents') })
		const objectFn = query({ args: object, handler: () => null })
		// Calls do not build validators either.
		await call(fn, { name: ' a ' })
		await call(objectFn, { id: 'x' })
		expect(name.native).toBe(k.string().validator)
		expect([
			count.native,
			returns.native,
			returns.outputNative,
			object.native,
		]).toEqual([undefined, undefined, undefined, undefined])
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
			kCustomMutation(
				internalMutationGeneric,
				NoOp,
			)({
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

	it('validates customization args before input runs when the function declares args', async () => {
		const events: string[] = []
		const builder = kCustomQuery(queryGeneric, {
			args: { token: v.string() },
			input: (_ctx, args: { token: string }) => {
				events.push(`input:${args.token}`)
				return { ctx: {}, args: {} }
			},
		})
		const fn = builder({
			args: { x: k.string() },
			skipConvexValidation: true,
			handler: (_ctx, args) => {
				events.push(`handler:${args.x}`)
				return args.x
			},
		})
		await expect(call(fn, { x: 'a', token: 42 })).rejects.toMatchObject({
			data: { code: 'VALIDATION', issues: [{ path: ['token'], code: 'invalid_type' }] },
		})
		expect(events).toEqual([])
		expect(await call(fn, { x: 'a', token: 't' })).toBe('a')
		expect(events).toEqual(['input:t', 'handler:a'])
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

/** A field object the test edits after registration. */
interface MutableArgumentFields {
	[field: string]: KType
}

// Behaviours of the customization contract carried over from the v1 registration suite.
describe('customization contract', () => {
	it('invokes real public query, mutation and action registrations', async () => {
		const args = { value: k.string().trim() }
		const functions = {
			query: kCustomQuery(
				queryGeneric,
				NoOp,
			)({ args, returns: k.string(), handler: (_ctx, a) => a.value }),
			mutation: kCustomMutation(
				mutationGeneric,
				NoOp,
			)({
				args,
				returns: k.string(),
				handler: (_ctx, a) => a.value,
			}),
			action: kCustomAction(
				actionGeneric,
				NoOp,
			)({ args, returns: k.string(), handler: (_ctx, a) => a.value }),
		}
		const t = convexTest(schema, { ...modules, './functions.ts': async () => functions })
		expect(
			await t.query(makeFunctionReference<'query', { value: string }, string>('functions:query'), {
				value: ' q ',
			}),
		).toBe('q')
		expect(
			await t.mutation(
				makeFunctionReference<'mutation', { value: string }, string>('functions:mutation'),
				{ value: ' m ' },
			),
		).toBe('m')
		expect(
			await t.action(
				makeFunctionReference<'action', { value: string }, string>('functions:action'),
				{
					value: ' a ',
				},
			),
		).toBe('a')
	})

	it('passes the native ctx to input, lets made args win, and surfaces a failing success hook', async () => {
		let nativeCtx: GenericQueryCtx<GenericDataModel> | undefined
		const events: string[] = []
		const fn = kCustomQuery(queryGeneric, {
			args: {},
			input: (ctx) => {
				events.push('input')
				expect(ctx).toBe(nativeCtx)
				return {
					ctx: { patched: true },
					args: { text: 'made' },
					onSuccess: ({ ctx: successCtx, args, result }) => {
						events.push('success')
						expect(successCtx).toBe(nativeCtx)
						expect(args).toEqual({ text: 'four' })
						expect(result).toBe('made')
						throw new Error('hook failure')
					},
				}
			},
		})({
			args: { text: k.string().trim() },
			handler: (ctx, args) => {
				events.push('handler')
				expect(ctx.patched).toBe(true)
				return args.text
			},
		})
		await expect(
			harness().run((ctx) => {
				nativeCtx = ctx
				return runtime(fn)._handler(ctx, { text: ' four ' })
			}),
		).rejects.toThrow('hook failure')
		expect(events).toEqual(['input', 'handler', 'success'])
	})

	it('never runs the success hook after an args or handler failure, and lets input deny first', async () => {
		const events: string[] = []
		const builder = kCustomQuery(queryGeneric, {
			args: {},
			input: () => {
				events.push('input')
				return { ctx: {}, args: {}, onSuccess: () => void events.push('success') }
			},
		})
		const fn = builder({
			args: { value: k.number().min(0) },
			handler: (_ctx, args) => {
				events.push('handler')
				if (args.value === 0) throw new Error('handler failure')
				return args.value
			},
		})
		await expect(call(fn, { value: -1 })).rejects.toBeInstanceOf(ConvexError)
		expect(events).toEqual(['input'])
		events.length = 0
		await expect(call(fn, { value: 0 })).rejects.toThrow('handler failure')
		expect(events).toEqual(['input', 'handler'])
		const denied = kCustomQuery(queryGeneric, {
			args: {},
			input: () => {
				throw new Error('customization denial')
			},
		})({ args: { value: k.number().min(0) }, handler: () => null })
		await expect(call(denied, { value: -1 })).rejects.toThrow('customization denial')
	})

	it('hands raw args, made args and empty extras through a no-args definition', async () => {
		const seen: object[] = []
		const fn = kCustomQuery(queryGeneric, {
			args: { token: v.string() },
			input: (_ctx, args, extra) => {
				seen.push({ args, extra })
				return {
					ctx: {},
					args: { added: true },
					onSuccess: ({ args, result }) => void seen.push({ args, result }),
				}
			},
		})({ handler: (_ctx, args) => args })
		const raw = { token: 'secret', free: 42 }
		expect(await call(fn, raw)).toEqual({ ...raw, added: true })
		expect(seen).toEqual([
			{ args: raw, extra: {} },
			{ args: raw, result: { ...raw, added: true } },
		])
		expect(JSON.parse(runtime(fn).exportArgs())).toEqual({ type: 'any' })
	})

	it('rejects overlapping customization and declared args of different kinds at export', () => {
		const builder = kCustomQuery(queryGeneric, {
			args: { value: v.string() },
			input: () => ({ ctx: {}, args: {} }),
		})
		const fn = builder({ args: { value: k.number() }, handler: () => null })
		expect(() => runtime(fn).exportArgs()).toThrow(
			'Cannot intersect validators with different kinds: float64 and string',
		)
		const optional = builder({ args: { value: k.string().optional() }, handler: () => null })
		expect(JSON.parse(runtime(optional).exportArgs()).value.value.optional).toBe(false)
	})

	it('shares one native validator for a schema repeated across fields and auth query constructors', () => {
		const captured: GenericValidator[] = []
		const nativeQuery: typeof queryGeneric = (definition) => {
			if ('args' in definition && definition.args) captured.push(asObjectValidator(definition.args))
			return queryGeneric(definition)
		}
		const nativeInternalQuery: typeof internalQueryGeneric = (definition) => {
			if ('args' in definition && definition.args) captured.push(asObjectValidator(definition.args))
			return internalQueryGeneric(definition)
		}
		const child = k.object({ id: k.id('tasks'), text: k.string() })
		const array = k.array(child)
		const union = k.union([child, array])
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
		const plain = kCustomQuery(nativeQuery, {
			args: { token: v.id('sessions') },
			input: () => ({ ctx: {}, args: {} }),
		})({ args, handler: () => null })
		const exported = [runtime(plain).exportArgs()]
		for (const builder of [
			auth.authQuery,
			auth.roleQuery('owner'),
			auth.adminQuery,
			auth.systemQuery,
		])
			exported.push(runtime(builder({ args, handler: () => null })).exportArgs())
		expect(captured).toHaveLength(5)
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
		expect(JSON.parse(exported[0]).value.token).toEqual({
			fieldType: { type: 'id', tableName: 'sessions' },
			optional: false,
		})
		for (const json of exported.slice(1)) expect(json).toBe(exported[1])
	})

	it('passes a definition-supplied __proto__ option through as an own extra field', async () => {
		let extra: { admin?: unknown; tag?: unknown } | undefined
		const builder = kCustomQuery(queryGeneric, {
			args: {},
			input: (_ctx, _args, options) => {
				// SAFETY: the kit forwards the definition's extra options record unchanged.
				extra = options as typeof extra
				return { ctx: {}, args: {} }
			},
		})
		// SAFETY: JSON.parse creates an own `__proto__` key, the shape object rest preserved.
		const options = JSON.parse('{"__proto__": {"admin": true}, "tag": "x"}') as object
		// SAFETY: the extra options are untyped on purpose; only their forwarding is under test.
		const fn = builder({ ...options, handler: () => null } as never)
		await call(fn, {})
		expect(Object.getPrototypeOf(extra)).toBe(Object.prototype)
		expect(Object.hasOwn(extra!, '__proto__')).toBe(true)
		expect(extra!.admin).toBeUndefined()
		expect(extra!.tag).toBe('x')
	})

	it('captures the args field object at registration', async () => {
		const fields: MutableArgumentFields = { value: k.string() }
		const fn = query({ args: fields, handler: (_ctx, parsed) => parsed })
		fields.later = k.string()
		fields.value = k.number()
		expect(JSON.parse(runtime(fn).exportArgs())).toEqual({
			type: 'object',
			value: { value: { fieldType: { type: 'string' }, optional: false } },
		})
		expect(Object.isFrozen(fields)).toBe(false)
	})

	it('surfaces a throwing args getter at export and invocation, never running unvalidated', async () => {
		let reads = 0
		const handled: unknown[] = []
		const fn = query({
			get args(): { value: KType } {
				reads++
				throw new Error('broken args')
			},
			handler: (_ctx, args) => {
				handled.push(args)
				return null
			},
		})
		expect(reads).toBe(0)
		expect(() => runtime(fn).exportArgs()).toThrow('broken args')
		for (let attempt = 0; attempt < 2; attempt++)
			await expect(call(fn, { value: 'x' })).rejects.toThrow('broken args')
		expect(handled).toEqual([])
		expect(reads).toBe(1)
	})

	it('rejects nonobject getter args at export instead of registration', () => {
		const fn = query({
			// @ts-expect-error runtime rejection of nonobject argument schemas
			get args() {
				return k.string()
			},
			handler: () => null,
		})
		expect(() => runtime(fn).exportArgs()).toThrow('Unsupported args schema')
	})
})
