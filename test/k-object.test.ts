import { v } from 'convex/values'
import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { describe, expect, it } from 'vitest'
import { k } from '../src/k'

function nativeJson(validator: GenericValidator): string {
	// SAFETY: Convex validators expose the json getter at runtime; declarations mark it internal.
	return JSON.stringify((validator as GenericValidator & { readonly json: ValidatorJSON }).json)
}

const title = k.string().trim().min(1)
const task = k.object({ title, note: k.string().optional(), done: k.boolean().default(false) })

describe('k object helpers', () => {
	it('exposes the field map, and reusing a field leaves it unchanged', () => {
		expect(task.shape.title).toBe(title)
		const optionalTitle = task.shape.title.optional()
		expect(task.shape.title).toBe(title)
		expect(optionalTitle.unwrap()).toBe(title)
		expect(task.refine(() => true).shape).toBe(task.shape)
	})

	it('pick, omit and extend keep the retained field schemas and their checks', () => {
		const picked = task.pick('title')
		const omitted = task.omit('note', 'done')
		const extended = task.extend({ owner: k.id('users') })
		for (const schema of [picked, omitted, extended]) {
			expect(schema.shape.title).toBe(title)
			expect(schema.safeParse({ title: '  ', owner: 'u' }).success).toBe(false)
		}
		expect(Object.keys(picked.shape)).toEqual(['title'])
		expect(Object.keys(omitted.shape)).toEqual(['title'])
		expect(Object.keys(extended.shape)).toEqual(['title', 'note', 'done', 'owner'])
		expect(nativeJson(picked.validator)).toBe(nativeJson(v.object({ title: v.string() })))
		expect(picked.parse({ title: ' a ' })).toEqual({ title: 'a' })
	})

	it('extend replaces a field present in both', () => {
		const replaced = task.extend({ title: k.number() })
		expect(nativeJson(replaced.validator)).toBe(
			nativeJson(
				v.object({
					title: v.number(),
					note: v.optional(v.string()),
					done: v.optional(v.boolean()),
				}),
			),
		)
	})

	it('partial makes every field optional natively and keeps each check', () => {
		const partial = task.partial()
		expect(nativeJson(partial.validator)).toBe(
			nativeJson(
				v.object({
					title: v.optional(v.string()),
					note: v.optional(v.string()),
					done: v.optional(v.boolean()),
				}),
			),
		)
		expect(partial.parse({})).toEqual({ done: false })
		expect(partial.safeParse({ title: ' ' }).success).toBe(false)
		expect(partial.shape.title.unwrap()).toBe(title)
	})

	it('matches the native VObject methods by exported JSON', () => {
		const native = v.object({ title: v.string(), note: v.optional(v.string()) })
		const schema = k.object({ title: k.string(), note: k.string().optional() })
		expect(nativeJson(schema.pick('note').validator)).toBe(nativeJson(native.pick('note')))
		expect(nativeJson(schema.omit('note').validator)).toBe(nativeJson(native.omit('note')))
		expect(nativeJson(schema.partial().validator)).toBe(nativeJson(native.partial()))
		expect(nativeJson(schema.extend({ n: k.number() }).validator)).toBe(
			nativeJson(native.extend({ n: v.number() })),
		)
	})
})
