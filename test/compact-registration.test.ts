import { test, expect, describe } from 'vite-plus/test'
import { z } from 'zod'
import {
	queryGeneric,
	mutationGeneric,
	actionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	internalActionGeneric,
	defineSchema,
	defineTable,
	makeFunctionReference,
} from 'convex/server'
import { convexTest } from 'convex-test'
import { NoOp } from 'convex-helpers/server/customFunctions'
import { ConvexError, v, type GenericValidator, type ValidatorJSON } from 'convex/values'
import { zCustomQuery, zCustomMutation, zCustomAction } from '../src/zod-registration'
import { createAuthFunctions } from '../src/auth'
import {
	relationFilterSchema,
	scalarPredicateFromSchema,
	type FilterGrammar,
} from '../src/querying/shared/filters'
import { zodToConvex } from '../src/zod-convex'

const grammar: FilterGrammar = {
	fields: { value: scalarPredicateFromSchema(z.string(), true, false).optional() },
	relations: {},
}
function root() {
	return relationFilterSchema(grammar, undefined, { validator: 'compact' })
}
function runtime(fn: { isConvexFunction: true }) {
	// SAFETY: native builder methods exist at runtime and intentionally accept hostile in-process inputs for these proofs.
	return fn as {
		isConvexFunction: true
		exportArgs(): string
		_handler(ctx: any, args: any): Promise<any>
	}
}
const nested = (n: number, value: any): any => (n ? { not: nested(n - 1, value) } : value)
const modules = { './_generated/server.ts': async () => ({ query: queryGeneric }) }
const base = {
	query: queryGeneric,
	internalQuery: internalQueryGeneric,
	mutation: mutationGeneric,
	internalMutation: internalMutationGeneric,
	action: actionGeneric,
	internalAction: internalActionGeneric,
}

describe('paired compact registration boundary', () => {
	test('preflights before customization, with ordinary consumer hooks exactly once', async () => {
		const events: string[] = []
		const filters = root().refine(async () => {
			events.push('refine')
			return true
		})
		const fn = zCustomQuery(queryGeneric, {
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
		})({
			args: {
				filters: filters.optional(),
				other: z.string().transform((s) => {
					events.push('transform')
					return s.length
				}),
			},
			returns: z.number().transform((n) => {
				events.push('returns')
				return n
			}),
			handler: (_ctx, args) => {
				events.push('handler')
				return args.other
			},
		})
		await expect(
			runtime(fn)._handler({}, { filters: nested(2, { value: 7 }), other: 'ok' }),
		).rejects.toBeInstanceOf(ConvexError)
		expect(events).toEqual([])
		const invalidEvents = [...events]
		expect(
			await runtime(fn)._handler({}, { filters: nested(4, { value: 'ok' }), other: 'ok' }),
		).toBe(2)
		expect(events).toEqual(['input', 'refine', 'transform', 'handler', 'returns', 'success'])
		if (process.env.ISSUE59_CAPTURE) {
			const { writeFileSync } = await import('node:fs')
			writeFileSync(
				`${process.env.ISSUE59_CAPTURE}/callback-order.json`,
				JSON.stringify({ invalid: invalidEvents, valid: events }),
			)
		}
	})
	test.each([
		'authQuery',
		'roleQuery',
		'adminQuery',
		'systemQuery',
		'authMutation',
		'roleMutation',
		'adminMutation',
		'systemMutation',
		'authAction',
		'roleAction',
		'adminAction',
		'systemAction',
	] as const)('protects actual %s registration before auth or handler work', async (name) => {
		const counts = { auth: 0, role: 0, handler: 0, reads: 0 }
		const auth = createAuthFunctions({
			...base,
			getAuthUser: async () => {
				counts.auth++
				return { id: 'u' }
			},
			mapRole: () => {
				counts.role++
				return 'owner'
			},
			adminRoles: ['owner'],
		})
		const builders = {
			...auth,
			roleQuery: auth.roleQuery('owner'),
			roleMutation: auth.roleMutation('owner'),
			roleAction: auth.roleAction('owner'),
		}
		// SAFETY: this table intentionally dispatches the registered query/mutation/action adapters with an unused generic context.
		const builder = builders[name] as any
		const fn = builder({
			args: { filters: root().optional() },
			handler: async (ctx: any) => {
				counts.handler++
				if (ctx.db) {
					counts.reads++
					await ctx.db.query('items').collect()
				}
				return null
			},
		})
		// Run through convex-test's module/function dispatch, not only the raw handler.
		const kind = name.endsWith('Mutation')
			? 'mutation'
			: name.endsWith('Action')
				? 'action'
				: 'query'
		const t = convexTest(defineSchema({ items: defineTable({ value: v.string() }) }), {
			...modules,
			'./functions.ts': async () => ({ check: fn }),
		}).withIdentity({ subject: 'u', org_id: 'o', role: 'owner' })
		const ref = makeFunctionReference<any>('functions:check')
		const invoke = (args: any) =>
			kind === 'query'
				? t.query(ref, args)
				: kind === 'mutation'
					? t.mutation(ref, args)
					: t.action(ref, args)
		await expect(invoke({ filters: nested(2, { value: 7 }) })).rejects.toThrow()
		expect(counts).toEqual({ auth: 0, role: 0, handler: 0, reads: 0 })
		const invalidCounts = { ...counts }
		await invoke({ filters: nested(4, { value: 'ok' }) })
		expect(counts.handler).toBe(1)
		expect(counts.reads).toBe(kind === 'action' ? 0 : 1)
		if (process.env.ISSUE59_CAPTURE) {
			const { writeFileSync } = await import('node:fs')
			writeFileSync(
				`${process.env.ISSUE59_CAPTURE}/counts-${name}.json`,
				JSON.stringify({ invalid: invalidCounts, valid: counts }),
			)
		}
	})
	test.each(['map', 'object', 'nested', 'optional'] as const)(
		'guards supported %s placement without invoking accessors',
		async (placement) => {
			const page = z.object({ filters: root().optional() })
			const args =
				placement === 'map'
					? page.shape
					: placement === 'object'
						? page
						: z.object({ page: placement === 'optional' ? page.optional() : page })
			let calls = 0
			const fn = zCustomQuery(queryGeneric, {
				args: {},
				input: () => {
					calls++
					return { ctx: {}, args: {} }
				},
			})({ args, handler: () => null })
			const bad = { filters: nested(2, { value: 8 }) }
			const wrap = (v: any) => (placement === 'map' || placement === 'object' ? v : { page: v })
			await expect(runtime(fn)._handler({}, wrap(bad))).rejects.toBeInstanceOf(ConvexError)
			let gets = 0
			const hostile = Object.defineProperty({}, 'filters', {
				enumerable: true,
				get() {
					gets++
					return {}
				},
			})
			await expect(runtime(fn)._handler({}, wrap(hostile))).rejects.toBeInstanceOf(ConvexError)
			expect(gets).toBe(0)
			expect(calls).toBe(0)
			if (placement === 'optional') await runtime(fn)._handler({}, {})
		},
	)
	test('rejects exact budget excesses and hostile layouts before customization or handlers', async () => {
		let calls = 0,
			gets = 0
		const fn = zCustomQuery(queryGeneric, {
			args: {},
			input: () => {
				calls++
				return { ctx: {}, args: {} }
			},
		})({
			args: { filters: root() },
			handler: () => {
				calls++
				return null
			},
		})
		const cycle: any = {}
		cycle.not = cycle
		const getter = Object.defineProperty({}, 'value', {
			enumerable: true,
			get() {
				gets++
				return 'oops'
			},
		})
		const inherited = Object.create({ value: 'oops' })
		const sparse: any[] = []
		sparse.length = 1
		const hostile = [
			nested(5, {}),
			{ and: Array(255).fill({}) },
			{ value: { in: Array(101).fill('x') } },
			nested(2, { unknown: 'x' }),
			nested(2, { value: {} }),
			cycle,
			getter,
			inherited,
			{ and: sparse },
			{ [Symbol('x')]: 1 },
			new Date(),
			Object.assign([], { extra: 1 }),
		]
		for (const filters of hostile) {
			await expect(runtime(fn)._handler({}, { filters })).rejects.toBeInstanceOf(ConvexError)
			expect(calls).toBe(0)
		}
		expect(gets).toBe(0)
		for (const filters of [
			nested(4, {}),
			{ and: Array(254).fill({}) },
			{ value: { in: Array(100).fill('x') } },
		])
			await runtime(fn)._handler({}, { filters })
		expect(calls).toBe(6)
	})
	test('leaves unsupported wrappers, shape edits, defaults and skip mode on full conversion', async () => {
		const page = z.object({ filters: root().optional() })
		const edited = root()
		if (!(edited instanceof z.ZodObject)) throw new Error('Expected generated object')
		const cases = [
			z.object({ pages: z.array(page) }),
			z.object({ page: page.nullable() }),
			z.object({ page: page.default({}) }),
			z.object({ filters: edited.extend({ extra: z.string().optional() }) }),
		]
		for (const args of cases) {
			const fn = zCustomQuery(queryGeneric, NoOp)({ args, handler: () => null })
			expect(runtime(fn).exportArgs()).toBe(convertedJson(args))
		}
		const events: string[] = []
		const fn = zCustomQuery(queryGeneric, {
			args: {},
			input: () => {
				events.push('input')
				return { ctx: {}, args: {} }
			},
		})({ args: page, skipConvexValidation: true, handler: () => null })
		expect(JSON.parse(runtime(fn).exportArgs())).toEqual({ type: 'any' })
		await expect(
			runtime(fn)._handler({}, { filters: nested(2, { value: 7 }) }),
		).rejects.toBeInstanceOf(ConvexError)
		expect(events).toEqual(['input'])
	})
	test('guards native query mutation and action customization families', async () => {
		for (const [adapter, builder] of [
			[zCustomQuery, queryGeneric],
			[zCustomMutation, mutationGeneric],
			[zCustomAction, actionGeneric],
		] as const) {
			let calls = 0
			// SAFETY: the adapters share the private registration implementation; context is intentionally unused.
			const fn = (adapter as any)(builder, {
				args: {},
				input: () => {
					calls++
					return { ctx: {}, args: {} }
				},
			})({
				args: { filters: root() },
				handler: () => {
					calls++
					return null
				},
			})
			await expect(
				runtime(fn)._handler({}, { filters: nested(2, { value: 7 }) }),
			).rejects.toBeInstanceOf(ConvexError)
			expect(calls).toBe(0)
		}
	})
})

test('rejects invalid relation/variant grammar before customization on every supported clone', async () => {
	const child: FilterGrammar = {
		fields: { value: scalarPredicateFromSchema(z.enum(['a', 'b']), false, false).optional() },
		relations: {},
	}
	const generated = relationFilterSchema(
		{
			fields: child.fields,
			relations: {
				one: { cardinality: 'one', target: child },
				many: { cardinality: 'many', target: child },
			},
			variants: { discriminator: 'kind', options: { a: child, b: child } },
		},
		undefined,
		{ validator: 'compact' },
	)
	for (const filters of [
		generated,
		generated.clone(),
		generated.describe('filters'),
		generated.meta({ title: 'filters' }),
		generated.refine(() => true),
	]) {
		let work = 0
		const args = z
			.object({ filters: filters.optional() })
			.clone()
			.extend({ other: z.string().optional() })
		const fn = zCustomQuery(queryGeneric, {
			args: {},
			input: () => {
				work++
				return { ctx: {}, args: {} }
			},
		})({
			args,
			handler: () => {
				work++
				return null
			},
		})
		for (const value of [
			{ not: { not: { variant: { tag: 'bad', filters: {} } } } },
			{ not: { not: { many: { some: {}, none: {} } } } },
			{ not: { not: { many: {} } } },
			{ not: { not: { value: 'bad' } } },
			{ not: { not: { value: { gt: 'a' } } } },
		]) {
			await expect(runtime(fn)._handler({}, { filters: value })).rejects.toBeInstanceOf(ConvexError)
			expect(work).toBe(0)
		}
		await runtime(fn)._handler({}, { filters: { not: { one: { value: 'a' } } } })
		expect(work).toBe(2)
	}
})

test('keeps generated nonempty checks isolated from public check mutation', () => {
	const scalar = scalarPredicateFromSchema(z.string(), false, false)
	const generated = relationFilterSchema(
		{ fields: { value: scalar.optional() }, relations: {} },
		undefined,
		{ validator: 'compact' },
	)
	const fn = zCustomQuery(queryGeneric, NoOp)({ args: { filters: generated }, handler: () => null })
	// SAFETY: this proof deliberately alters the public generated operator refinement.
	const union = scalar as z.ZodUnion<[z.ZodString, z.ZodObject]>
	const check = union.options[1]._zod.def.checks![0]
	// SAFETY: scalarPredicateFromSchema attaches a classic custom nonempty refinement.
	if (!(check instanceof z.ZodCustom)) throw new Error('Expected generated refinement')
	check._zod.def.fn = () => true
	return expect(
		runtime(fn)._handler({}, { filters: nested(2, { value: {} }) }),
	).rejects.toBeInstanceOf(ConvexError)
})

test('does not run consumer rejection or transformation twice', async () => {
	let refinements = 0,
		transforms = 0,
		inputs = 0,
		handlers = 0
	const filters = root().refine(() => {
		refinements++
		return false
	})
	const fn = zCustomQuery(queryGeneric, {
		args: {},
		input: () => {
			inputs++
			return { ctx: {}, args: {} }
		},
	})({
		args: { filters },
		handler: () => {
			handlers++
			return null
		},
	})
	await expect(runtime(fn)._handler({}, { filters: { value: 'valid' } })).rejects.toBeInstanceOf(
		ConvexError,
	)
	expect({ refinements, inputs, handlers }).toEqual({ refinements: 1, inputs: 1, handlers: 0 })
	const transformed = root().transform((value) => {
		transforms++
		return value
	})
	const fallback = zCustomQuery(
		queryGeneric,
		NoOp,
	)({ args: { filters: transformed }, handler: () => null })
	expect(runtime(fallback).exportArgs()).toBe(convertedJson(z.object({ filters: transformed })))
	await runtime(fallback)._handler({}, { filters: { value: 'valid' } })
	expect(transforms).toBe(1)
})

function convertedJson(schema: z.ZodObject): string {
	return JSON.stringify(nativeJson(zodToConvex(schema)))
}

function nativeJson(validator: GenericValidator): ValidatorJSON {
	// SAFETY: actual Convex validators expose their registration JSON at runtime.
	return (validator as GenericValidator & { json: ValidatorJSON }).json
}
