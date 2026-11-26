import { NoOp } from 'convex-helpers/server/customFunctions'
import { actionGeneric, mutationGeneric, queryGeneric } from 'convex/server'
import { v } from 'convex/values'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
const conversions = vi.hoisted(() => ({ args: 0, returns: 0, fields: 0 }))

// The v2 conversion points: a `k` schema's input-side and output-side native validators.
vi.mock('../src/k/compile', async (importOriginal) => {
	const original = await importOriginal<typeof import('../src/k/compile')>()
	return {
		...original,
		compileNative: (...input: Parameters<typeof original.compileNative>) => {
			conversions.args++
			return original.compileNative(...input)
		},
		compileOutput: (...input: Parameters<typeof original.compileOutput>) => {
			conversions.returns++
			return original.compileOutput(...input)
		},
	}
})
vi.mock('convex-helpers/validators', async (importOriginal) => {
	const original = await importOriginal<typeof import('convex-helpers/validators')>()
	return {
		...original,
		addFieldsToValidator: (...input: Parameters<typeof original.addFieldsToValidator>) => {
			conversions.fields++
			return original.addFieldsToValidator(...input)
		},
	}
})

const { kCustomAction, kCustomMutation, kCustomQuery } = await import('../src/registration')
const { k } = await import('../src/k')

// `k.string()` and other leaf factories share one immutable root; `.min(1)` makes each declaration its
// own record, so every count below belongs to the function under test.

function exported(fn: { isConvexFunction: true }) {
	// SAFETY: native builders attach these export thunks at runtime; the public type strips them.
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The export thunks are absent from the public type.
	return fn as unknown as { exportArgs(): string; exportReturns(): string }
}

const customization = { args: { token: v.string() }, input: () => ({ ctx: {}, args: {} }) }
const builders = {
	query: kCustomQuery(queryGeneric, customization),
	mutation: kCustomMutation(mutationGeneric, customization),
	action: kCustomAction(actionGeneric, NoOp),
}

describe('registration defers validator conversion', () => {
	beforeEach(() => {
		conversions.args = 0
		conversions.returns = 0
		conversions.fields = 0
	})

	for (const [family, builder] of Object.entries(builders)) {
		it(`${family}: data and getter declarations convert only when exported`, () => {
			let reads = 0
			const functions = [
				builder({
					args: { value: k.string().min(1) },
					returns: k.object({ ok: k.boolean() }),
					handler: () => ({ ok: true }),
				}),
				builder({
					get args() {
						reads++
						return { value: k.string().min(1) }
					},
					get returns() {
						reads++
						return k.object({ ok: k.boolean() })
					},
					handler: () => ({ ok: true }),
				}),
			]
			expect(conversions).toEqual({ args: 0, returns: 0, fields: 0 })
			expect(reads).toBe(0)
			for (const fn of functions) exported(fn).exportArgs()
			expect(conversions.returns).toBe(0)
			expect(conversions.args).toBeGreaterThan(0)
			expect(conversions.fields).toBe(2)
			for (const fn of functions) exported(fn).exportReturns()
			expect(conversions.returns).toBe(2)
			expect(reads).toBe(2)
		})
	}
})

describe('Effect API adapters', () => {
	beforeEach(() => {
		conversions.args = 0
		conversions.returns = 0
		conversions.fields = 0
	})

	it('keep getter-declared args and returns unread through registration', async () => {
		const { effectApiBuilder } = await import('../src/effect')
		const adapters = [
			effectApiBuilder(kCustomQuery(queryGeneric, NoOp), {}),
			effectApiBuilder(queryGeneric, {}),
		]
		for (const query of adapters) {
			let reads = 0
			const fn = query({
				get args() {
					reads++
					return { value: k.string().min(1) }
				},
				get returns() {
					reads++
					return k.string()
				},
				handler: (_ctx, { value }) => value,
			})
			expect(reads).toBe(0)
			expect(conversions).toEqual({ args: 0, returns: 0, fields: 0 })
			expect(JSON.parse(exported(fn).exportArgs())).toEqual({
				type: 'object',
				value: { value: { fieldType: { type: 'string' }, optional: false } },
			})
			expect(reads).toBe(1)
			expect(conversions.returns).toBe(0)
			conversions.args = 0
			conversions.fields = 0
		}
	})
})
