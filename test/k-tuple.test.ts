import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { NoOp } from 'convex-helpers/server/customFunctions'
import {
	defineSchema,
	queryGeneric,
	type GenericQueryCtx,
	type GenericDataModel,
} from 'convex/server'
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vite-plus/test'
import { k } from '../src/k'
import { containsTransform, idPath, runDeclared, transformPath } from '../src/k/parse'
import { kCustomQuery } from '../src/registration'
import { kTable } from '../src/table'

describe('tuples', () => {
	it('parses fixed, empty, nested and rest positions and always runs declared checks', () => {
		const pair = k.tuple([k.string(), k.number()])
		expect(pair.parse(['a', 1])).toEqual(['a', 1])
		for (const bad of [[1, 'a'], [], ['a'], ['a', 1, 2], null])
			expect(pair.safeParse(bad).success).toBe(false)
		expect(() => runDeclared(pair, [1, 'a'])).toThrow()
		expect(() => runDeclared(pair, ['a'])).toThrow()
		expect(k.tuple([]).parse([])).toEqual([])
		expect(k.tuple([]).safeParse([1]).success).toBe(false)
		for (const schema of [k.tuple([pair], k.boolean()), k.tuple([pair]).rest(k.boolean())]) {
			expect(schema.parse([['a', 1], true, false])).toEqual([['a', 1], true, false])
			expect(schema.safeParse([['a', 1], 1])).toMatchObject({ issues: [{ path: [1] }] })
		}
		expect(nativeJson(pair.validator)).toEqual({
			type: 'array',
			value: { type: 'union', value: [{ type: 'string' }, { type: 'number' }] },
		})
		expect(nativeJson(k.tuple([]).validator)).toEqual({
			type: 'array',
			value: { type: 'union', value: [] },
		})
		expect(k.tuple([k.string()]).validator.element.kind).toBe('string')
	})
	it('enforces positions through registered argument parsing after broad native validation', async () => {
		const pair = k.tuple([k.string(), k.number()])
		const table = kTable('tupleRows', { pair }, { publicFields: ['pair'] })
		const t = convexTest(defineSchema({ tupleRows: table.table }), {
			'./_generated/server.ts': async () => ({}),
		})
		const query = kCustomQuery(queryGeneric, NoOp)
		const fn = query({ args: { pair }, handler: (_ctx, args) => args.pair })
		const native = retyped<{
			exportArgs(): string
			_handler(
				ctx: GenericQueryCtx<GenericDataModel>,
				args: { pair: [string, number] },
			): Promise<[string, number]>
		}>(fn)
		expect(JSON.parse(native.exportArgs())).toMatchObject({
			value: { pair: { fieldType: { type: 'array' } } },
		})
		expect(await t.run((ctx) => native._handler(ctx, { pair: ['a', 1] }))).toEqual(['a', 1])
		// SAFETY: both values satisfy the native member union but violate their declared positions.
		await expect(
			t.run((ctx) => native._handler(ctx, { pair: [1, 'a'] } as never)),
		).rejects.toThrow()
		// Direct database writes see only Convex's broader array union.
		const id = await t.run((ctx) =>
			ctx.db.insert('tupleRows', retyped<{ pair: [string, number] }>({ pair: [1, 'a'] })),
		)
		const row = await t.run((ctx) => ctx.db.get(id))
		// SAFETY: an out-of-order row can be written directly; kit projection must reject it.
		expect(() => table.toPublicDto(row as never)).toThrow()
	})

	it('rejects holes, undefined inputs and undefined outputs, before defaults can supply positions', () => {
		for (const schema of [
			k.tuple([k.any()]),
			k.tuple([k.string().default('x')]),
			k.tuple([]).rest(k.any()),
		]) {
			expect(schema.safeParse([undefined]).success).toBe(false)
			expect(schema.safeParse(Array(1)).success).toBe(false)
		}
		expect(k.tuple([k.string().default('x')]).safeParse([]).success).toBe(false)
		expect(k.tuple([k.any().transform(() => undefined)]).safeParse([1]).success).toBe(false)
	})
	it('rejects optional and void slots lazily, and permits defaulted required slots', () => {
		for (const member of [k.string().optional(), k.void(), k.string().default('x').optional()]) {
			const tuple = k.tuple([member])
			expect(tuple.native).toBeUndefined()
			expect(() => tuple.validator).toThrow(/tuple/)
			expect(() => tuple.parse(['x'])).toThrow(/tuple/)
			expect(() => k.tuple([], member).validator).toThrow(/tuple/)
		}
		expect(k.tuple([k.string().optional().default('x')]).parse(['a'])).toEqual(['a'])
	})
	it('keeps rest immutable, copies items, validates children, and rejects rest after checks', () => {
		const items = [k.string()]
		const tuple = k.tuple(items)
		items.push(k.string())
		expect(tuple.parse(['a'])).toEqual(['a'])
		expect(tuple.rest(k.number()).rest(k.boolean()).parse(['a', true])).toEqual(['a', true])
		expect(tuple.safeParse(['a', 1]).success).toBe(false)
		expect(() => tuple.refine(() => true).rest(k.number())).toThrow()
		// SAFETY: simulates untyped callers passing foreign children.
		expect(() => k.tuple([{} as ReturnType<typeof k.string>])).toThrow(/schema/)
	})
	it('recurses strictly, fills fresh nested defaults and carries outer object derivations', () => {
		const tuple = k
			.tuple([k.object({ tags: k.array(k.string()).default([]) })])
			.rest(k.object({ label: k.string() }))
		expect(tuple.parse([{}, { label: 'x', extra: 1 }])).toEqual([{ tags: [] }, { label: 'x' }])
		expect(tuple['~safeParseStrict']([{}, { label: 'x', extra: 1 }]).success).toBe(false)
		tuple.parse([{}])[0].tags.push('leak')
		expect(tuple.parse([{}])).toEqual([{ tags: [] }])
		const object = k.object({ tuple })
		expect(object.partial().parse({})).toEqual({})
		expect(object.pick('tuple').parse({ tuple: [{}] })).toEqual({ tuple: [{ tags: [] }] })
		expect(object.omit('tuple').parse({})).toEqual({})
		expect(k.tuple([k.string()]).nullable().parse(null)).toBeNull()
	})
	it('propagates transforms, catches, ids and input/output native validators', () => {
		const tuple = k.tuple([k.string().transform(Number)])
		expect(tuple.parse(['2'])).toEqual([2])
		expect(tuple.outputValidator.element.kind).toBe('any')
		expect(containsTransform(tuple)).toBe(true)
		expect(transformPath(tuple)).toBe('[0]')
		expect(transformPath(k.tuple([]).rest(k.string().catch('x')))).toBe('[rest]')
		expect(idPath(k.tuple([k.id('users')]))).toBe('[0]')
		// SAFETY: untyped definitions must still reject transforms at table boundaries.
		expect(() => kTable('bad', { tuple } as never).table).toThrow(/transform/)
		const query = kCustomQuery(queryGeneric, NoOp)
		// SAFETY: verifies runtime return guards for untyped declarations.
		const fn = query({ args: {}, returns: tuple as never, handler: () => null })
		// SAFETY: Convex exposes exportReturns at runtime as its deployment metadata hook.
		const exported = retyped<{ exportReturns(): string }>(fn)
		expect(() => exported.exportReturns()).toThrow(/transform/)
		const table = kTable(
			'pairs',
			{ tuple: k.tuple([k.string(), k.object({ n: k.number().default(1) })]) },
			{ publicFields: ['tuple'] },
		)
		expect(table.insertSchema.parse({ tuple: ['a', {}] })).toEqual({ tuple: ['a', { n: 1 }] })
		expect(table.toPublicDto({ tuple: ['a', {}] })).toMatchObject({ tuple: ['a', { n: 1 }] })
		// SAFETY: malformed stored rows can arrive from direct writes and must be rechecked.
		expect(() => table.toPublicDto({ tuple: [1, { n: 1 }] } as never)).toThrow()
	})
})

function nativeJson(validator: GenericValidator): ValidatorJSON {
	// SAFETY: Convex exposes json at runtime but marks it internal in declarations.
	return (validator as GenericValidator & { readonly json: ValidatorJSON }).json
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test-only view of Convex's runtime metadata and handler hooks.
function retyped<T>(value: unknown): T {
	// SAFETY: tests inspect runtime hooks omitted from the public registration type.
	return value as T
}
