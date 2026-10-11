import { zodToConvex as helper } from 'convex-helpers/server/zod4'
import type { GenericValidator, ValidatorJSON } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import * as mini from 'zod/mini'

import { convexToZod, zid, zodToConvex } from '../src/zod-table'

type MutableColumns = { value: z.ZodType }

function metadata(native: GenericValidator) {
	// SAFETY: Convex runtime validators expose the public json getter, omitted by their declaration.
	return (native as GenericValidator & { json: ValidatorJSON }).json
}

// Count distinct public native containers, not expanded JSON occurrences or timings.
function containerCount(root: GenericValidator): number {
	const seen = new Set<GenericValidator>()
	function visit(node: GenericValidator) {
		if (seen.has(node)) return
		seen.add(node)
		if (node.kind === 'object') Object.values(node.fields).forEach(visit)
		if (node.kind === 'array') visit(node.element)
		if (node.kind === 'union') node.members.forEach(visit)
	}
	visit(root)
	return [...seen].filter((node) => ['object', 'array', 'union'].includes(node.kind)).length
}

describe('public kit zodToConvex', () => {
	it('reuses completed repeated container identities with unchanged native metadata', () => {
		const leaf = z.object({ name: z.string(), id: zid('tasks') })
		const array = z.array(leaf)
		const union = z.union([leaf, array])
		const optional = union.optional()
		const schema = z.object({
			a: leaf,
			b: leaf,
			c: array,
			d: array,
			e: union,
			f: union,
			g: optional,
			h: optional,
		})
		const old = helper(schema)
		const actual = zodToConvex(schema)
		expect(old.fields.a).not.toBe(old.fields.b)
		expect(actual.fields.a).toBe(actual.fields.b)
		expect(actual.fields.c).toBe(actual.fields.d)
		expect(actual.fields.e).toBe(actual.fields.f)
		expect(actual.fields.g).toBe(actual.fields.h)
		expect(JSON.stringify(metadata(actual))).toBe(JSON.stringify(metadata(old)))
		expect(containerCount(actual)).toBe(5)
		expect(containerCount(old)).toBe(23)
	})

	it('matches the helper for handled wrappers and preserves native ID metadata', () => {
		const id = zid('tasks')
		const schemas = [
			z.object({ id, optional: id.optional() }),
			z.array(id),
			z.union([id, z.null()]),
			id.optional(),
			id.nullable(),
			id.optional().nullable(),
			id.nullable().optional(),
			id.optional().nonoptional(),
		]
		for (const schema of schemas)
			expect(metadata(zodToConvex(schema))).toEqual(metadata(helper(schema)))
		const nullable = z.object({ id }).optional().nullable()
		const required = nullable.nonoptional()
		const repeated = zodToConvex(z.object({ a: nullable, b: nullable, c: required, d: required }))
		expect(repeated.fields.a).toBe(repeated.fields.b)
		expect(repeated.fields.c).toBe(repeated.fields.d)
		expect(repeated.fields.a.isOptional).toBe('optional')
		expect(repeated.fields.c.isOptional).toBe('required')
		expect(metadata(zodToConvex(id))).toEqual({ type: 'id', tableName: 'tasks' })
		expect(metadata(zodToConvex(convexToZod(zodToConvex(id))))).toEqual(metadata(helper(id)))
	})

	it('retains delegated non-filter conversion and rejection behavior', () => {
		const id = zid('tasks')
		const schemas = [
			id.default(id.parse('tasks:1')),
			z.string().transform((s) => s.length),
			z.string().pipe(z.string()),
			z.record(z.string(), id),
			z.record(z.enum(['a', 'b']), id.optional()),
			z.tuple([id, z.number()]),
			z.intersection(z.object({ id }), z.object({ count: z.number() })),
			z.object({ id }).readonly(),
			z.string().catch('fallback'),
			z.lazy(() => id),
			z.unknown(),
			z.any(),
			z.never(),
		]
		for (const schema of schemas) {
			expect(metadata(zodToConvex(schema))).toEqual(metadata(helper(schema)))
			expect(metadata(zodToConvex(z.object({ value: schema })))).toEqual(
				metadata(helper(z.object({ value: schema }))),
			)
		}
		for (const schema of [z.date(), z.undefined(), z.array(z.string().optional())]) {
			expect(() => helper(schema)).toThrow()
			expect(() => zodToConvex(schema)).toThrow()
		}
	})

	it('supports Mini containers and wrappers through the original core contract', () => {
		const child = mini.object({ id: zid('tasks'), title: mini.string() })
		const optional = mini.optional(mini.union([child, mini.array(child)]))
		const schema = mini.object({
			a: child,
			b: child,
			optional,
			nullable: mini.nullable(optional),
			required: mini.nonoptional(optional),
		})
		const native = zodToConvex(schema)
		expect(metadata(native)).toEqual(metadata(helper(schema)))
		expect(native.fields.a).toBe(native.fields.b)
		for (const fallback of [
			mini._default(child, { id: zid('tasks').parse('tasks:1'), title: 'title' }),
			mini.pipe(mini.string(), mini.string()),
			mini.record(mini.string(), child),
			mini.tuple([child, mini.number()]),
			mini.intersection(child, mini.object({ extra: mini.boolean() })),
		]) {
			expect(metadata(zodToConvex(fallback))).toEqual(metadata(helper(fallback)))
		}
	})

	it('starts a fresh cache and observes mutations between conversions', () => {
		const columns: MutableColumns = { value: z.string() }
		const child = z.object(columns)
		const schema = z.object({ a: child, b: child })
		const first = zodToConvex(schema)
		const second = zodToConvex(schema)
		expect(first.fields.a).not.toBe(second.fields.a)
		child.shape.value = z.number()
		const third = zodToConvex(schema)
		expect(metadata(third)).toEqual(metadata(helper(schema)))
		expect(third.fields.a.fields.value.kind).toBe('float64')
		expect(first.fields.a.fields.value.kind).toBe('string')
	})

	it('rejects ancestor cycles on handled containers instead of completing a partial cache', () => {
		const columns: Record<string, z.ZodType> = {}
		const cyclic = z.object(columns)
		cyclic.shape.self = cyclic
		expect(() => zodToConvex(cyclic)).toThrow('CYCLIC_FILTER_SCHEMA')
		for (const wrapper of [
			cyclic.optional(),
			cyclic.nullable(),
			cyclic.optional().nonoptional(),
			z.array(cyclic),
			z.union([cyclic, z.null()]),
		]) {
			cyclic.shape.self = wrapper
			expect(() => zodToConvex(cyclic)).toThrow('CYCLIC_FILTER_SCHEMA')
		}
		delete cyclic.shape.self
		cyclic.shape.value = z.string()
		expect(metadata(zodToConvex(cyclic))).toEqual(metadata(helper(cyclic)))
	})
})
