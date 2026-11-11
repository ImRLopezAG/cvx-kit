import { NoOp } from 'convex-helpers/server/customFunctions'
import { actionGeneric, mutationGeneric, queryGeneric } from 'convex/server'
import { v } from 'convex/values'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { z } from 'zod'

const conversions = vi.hoisted(() => ({ args: 0, returns: 0, fields: 0 }))

vi.mock('../src/zod-convex', async (importOriginal) => {
	const original = await importOriginal<typeof import('../src/zod-convex')>()
	return {
		...original,
		zodToConvex: (...input: Parameters<typeof original.zodToConvex>) => {
			conversions.args++
			return original.zodToConvex(...input)
		},
	}
})
vi.mock('convex-helpers/server/zod4', async (importOriginal) => {
	const original = await importOriginal<typeof import('convex-helpers/server/zod4')>()
	return {
		...original,
		zodOutputToConvex: (...input: Parameters<typeof original.zodOutputToConvex>) => {
			conversions.returns++
			return original.zodOutputToConvex(...input)
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

const { zCustomAction, zCustomMutation, zCustomQuery } = await import('../src/zod-registration')

function exported(fn: { isConvexFunction: true }) {
	// SAFETY: native builders attach these export thunks at runtime; the public type strips them.
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The export thunks are absent from the public type.
	return fn as unknown as { exportArgs(): string; exportReturns(): string }
}

const customization = { args: { token: v.string() }, input: () => ({ ctx: {}, args: {} }) }
const builders = {
	query: zCustomQuery(queryGeneric, customization),
	mutation: zCustomMutation(mutationGeneric, customization),
	action: zCustomAction(actionGeneric, NoOp),
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
					args: { value: z.string() },
					returns: z.object({ ok: z.boolean() }),
					handler: () => ({ ok: true }),
				}),
				builder({
					get args() {
						reads++
						return { value: z.string() }
					},
					get returns() {
						reads++
						return z.object({ ok: z.boolean() })
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
