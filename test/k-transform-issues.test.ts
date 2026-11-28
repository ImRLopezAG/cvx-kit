import { NoOp } from 'convex-helpers/server/customFunctions'
import {
	defineSchema,
	queryGeneric,
	type DefaultFunctionArgs,
	type GenericDataModel,
	type GenericQueryCtx,
} from 'convex/server'
import type { Value } from 'convex/values'
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vite-plus/test'
import { k } from '../src/k'
import { KValidationError } from '../src/k/issues'
import { runDeclared } from '../src/k/parse'
import { kCustomQuery } from '../src/registration'

const query = kCustomQuery(queryGeneric, NoOp)

function run(fn: { isConvexFunction: true }, args: DefaultFunctionArgs) {
	// SAFETY: native builders attach the runtime handler; Convex's public declaration strips it.
	const handler = (
		fn as {
			isConvexFunction: true
			_handler(ctx: GenericQueryCtx<GenericDataModel>, args: DefaultFunctionArgs): Promise<Value>
		}
	)._handler
	return convexTest(defineSchema({}), { './_generated/server.ts': async () => ({}) }).run((ctx) =>
		handler(ctx, args),
	)
}

const jsonList = k.string().transform((text, context): string[] => {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		context.addIssue({ message: 'Expected JSON' })
		return k.NEVER
	}
	if (!Array.isArray(parsed)) {
		context.addIssue({ code: 'invalid_type', message: 'Expected a list', path: ['root'] })
		return k.NEVER
	}
	return parsed.map(String)
})

describe('k transform issues', () => {
	it('fails parse with the added issues and discards the return value', () => {
		expect(jsonList.parse('["a",1]')).toEqual(['a', '1'])
		expect(jsonList.safeParse('nope')).toEqual({
			success: false,
			issues: [{ path: [], code: 'custom', message: 'Expected JSON' }],
		})
		expect(() => jsonList.parse('{}')).toThrow(KValidationError)
	})

	it('prefixes issue paths with the transformed value location', () => {
		const schema = k.object({ items: k.array(k.object({ tags: jsonList })) })
		expect(schema.safeParse({ items: [{ tags: '[]' }, { tags: '{}' }] })).toEqual({
			success: false,
			issues: [
				{ path: ['items', 1, 'tags', 'root'], code: 'invalid_type', message: 'Expected a list' },
			],
		})
	})

	it('reports several issues and ignores a returned value when issues were added', () => {
		const schema = k.number().transform((value, context) => {
			context.addIssue({ message: 'one' })
			context.addIssue({ message: 'two', path: ['x'] })
			return value
		})
		expect(schema.safeParse(1)).toEqual({
			success: false,
			issues: [
				{ path: [], code: 'custom', message: 'one' },
				{ path: ['x'], code: 'custom', message: 'two' },
			],
		})
	})

	it('fails with Invalid input when k.NEVER is returned without an issue', () => {
		const schema = k.string().transform(() => k.NEVER)
		expect(schema.safeParse('a')).toEqual({
			success: false,
			issues: [{ path: [], code: 'custom', message: 'Invalid input' }],
		})
	})

	it('keeps one-parameter transforms unchanged and passes them no context', () => {
		let seen = -1
		const schema = k.string().transform(function (this: void, ...args: unknown[]) {
			seen = args.length
			return String(args[0])
		})
		expect(schema.parse('a')).toBe('a')
		expect(seen).toBe(1)
		expect(
			k
				.string()
				.transform((text) => Number.parseInt(text))
				.parse('12'),
		).toBe(12)
	})

	it('keeps throwing transforms throwing', () => {
		const schema = k.string().transform((_text, _context) => {
			throw new Error('boom')
		})
		expect(() => schema.parse('a')).toThrow('boom')
	})

	it('reports issues on runDeclared, Standard Schema and the function boundary', async () => {
		expect(() => runDeclared(jsonList, 'x')).toThrow(KValidationError)
		expect(await jsonList['~standard'].validate('x')).toEqual({
			issues: [{ path: [], message: 'Expected JSON' }],
		})
		const fn = query({ args: { tags: jsonList }, handler: (_ctx, args) => args.tags })
		expect(await run(fn, { tags: '["a"]' })).toEqual(['a'])
		await expect(run(fn, { tags: 'x' })).rejects.toMatchObject({
			data: { code: 'VALIDATION', issues: [{ path: ['tags'], message: 'Expected JSON' }] },
		})
	})

	it('runs inside a pipe and a catch', () => {
		expect(jsonList.pipe(k.array(k.string()).min(1)).safeParse('x').success).toBe(false)
		expect(jsonList.catch([]).parse('x')).toEqual([])
	})
})
