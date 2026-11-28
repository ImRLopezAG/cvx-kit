import { NoOp } from 'convex-helpers/server/customFunctions'
import {
	defineSchema,
	queryGeneric,
	type DefaultFunctionArgs,
	type GenericDataModel,
	type GenericQueryCtx,
} from 'convex/server'
import type { GenericValidator, ValidatorJSON, Value } from 'convex/values'
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vite-plus/test'
import { toJsonSchema } from '../src/json-schema'
import { k } from '../src/k'
import { hasDeclaredBehaviour, runDeclared } from '../src/k/parse'
import { kCustomQuery } from '../src/registration'
import { kTable } from '../src/table'
import { toZod } from '../src/zod'

function json(validator: GenericValidator) {
	// SAFETY: Convex validators expose the json getter at runtime; declarations mark it internal.
	return (validator as GenericValidator & { readonly json: ValidatorJSON }).json
}

const query = kCustomQuery(queryGeneric, NoOp)

function boundary(fn: { isConvexFunction: true }) {
	// SAFETY: native builders attach these runtime methods; Convex's public declaration strips them.
	return fn as {
		isConvexFunction: true
		exportReturns(): string
		_handler(ctx: GenericQueryCtx<GenericDataModel>, args: DefaultFunctionArgs): Promise<Value>
	}
}

function run(fn: { isConvexFunction: true }, args: DefaultFunctionArgs) {
	const handler = boundary(fn)._handler
	return convexTest(defineSchema({}), { './_generated/server.ts': async () => ({}) }).run((ctx) =>
		handler(ctx, args),
	)
}

describe('k .catch()', () => {
	it('falls back to a value or the result of a function when parsing fails', () => {
		const role = k.enum(['admin', 'member']).catch('member')
		expect(role.parse('admin')).toBe('admin')
		expect(role.parse('owner')).toBe('member')
		expect(role.parse(undefined)).toBe('member')
		const seen: unknown[] = []
		const count = k
			.number()
			.min(0)
			.catch((context) => {
				seen.push(context.input, context.issues.map((issue) => issue.code))
				return 0
			})
		expect(count.parse(-1)).toBe(0)
		expect(seen).toEqual([-1, ['too_small']])
		expect(count.safeParse('x')).toEqual({ success: true, data: 0 })
	})

	it('does not validate the fallback and keeps other fields failing', () => {
		const loose = k.string().min(3).catch('x')
		expect(loose.parse(1)).toBe('x')
		const claims = k.object({ org: k.string().catch('none'), sub: k.string() })
		expect(claims.parse({ org: 1, sub: 'u' })).toEqual({ org: 'none', sub: 'u' })
		const result = claims.safeParse({ org: 1, sub: 2 })
		expect(result.success).toBe(false)
		if (!result.success) expect(result.issues.map((issue) => issue.path)).toEqual([['sub']])
	})

	it('a function boundary validates the whole caught value itself', async () => {
		const tier = k.object({ name: k.string(), level: k.int() }).catch({ name: 'free', level: 0 })
		expect(hasDeclaredBehaviour(tier)).toBe(true)
		expect(runDeclared(tier, { name: 'pro', level: 2 })).toEqual({ name: 'pro', level: 2 })
		expect(runDeclared(tier, { name: 'pro', level: 'x' })).toEqual({ name: 'free', level: 0 })
		expect(runDeclared(tier, 'anything')).toEqual({ name: 'free', level: 0 })
		const fn = query({ args: { tier }, handler: (_ctx, args) => args.tier })
		expect(await run(fn, { tier: { name: 'pro', level: 1.5 } })).toEqual({ name: 'free', level: 0 })
		expect(await run(fn, { tier: { name: 'pro', level: 1 } })).toEqual({ name: 'pro', level: 1 })
	})

	it('accepts anything natively on the input side and keeps the output side', () => {
		expect(json(k.string().catch('a').validator)).toEqual({ type: 'any' })
		expect(k.string().catch('a').validator.isOptional).toBe('required')
		expect(k.string().optional().catch('a').validator.isOptional).toBe('optional')
		expect(json(k.string().catch('a').optional().validator)).toEqual({ type: 'any' })
		expect(json(k.string().catch('a').outputValidator)).toEqual({ type: 'string' })
		expect(k.string().optional().catch('a').outputValidator.isOptional).toBe('optional')
		expect(json(k.object({ a: k.string().catch('x') }).validator)).toEqual({
			type: 'object',
			value: { a: { fieldType: { type: 'any' }, optional: false } },
		})
		expect(json(k.object({ a: k.string().catch('x') }).outputValidator)).toEqual({
			type: 'object',
			value: { a: { fieldType: { type: 'string' }, optional: false } },
		})
		expect(json(k.array(k.number().catch(0)).validator)).toEqual({
			type: 'array',
			value: { type: 'any' },
		})
	})

	it('is rejected on table fields and in returns', () => {
		expect(() => kTable('caught', { a: k.string().catch('x') })).toThrow(
			'Table field "a" on "caught" uses transform or pipe, or catch',
		)
		const fn = query({ returns: k.string().catch('x'), handler: () => 'x' })
		expect(() => boundary(fn).exportReturns()).toThrow(
			'A returns schema cannot transform or catch',
		)
	})

	it('converts to JSON Schema, Zod and Standard Schema', async () => {
		const schema = k.object({ n: k.number().catch(1) })
		expect(toJsonSchema(schema)).toMatchObject({ properties: { n: {} } })
		expect(toJsonSchema(schema, { io: 'output' })).toMatchObject({
			properties: { n: { type: 'number' } },
		})
		expect(() => toZod(schema)).toThrow('toZod: .catch() is not carried')
		expect(await schema['~standard'].validate({ n: 'x' })).toEqual({ value: { n: 1 } })
	})
})
