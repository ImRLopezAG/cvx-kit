import { expect, test } from 'vite-plus/test'
import { z } from 'zod'
import { captureDto, materializeDto, classifyDto } from '../src/querying/schema-snapshot'
import { zid, zodToConvex } from '../src/zod-table'
import type { GenericValidator, ValidatorJSON } from 'convex/values'
function json(value: GenericValidator): ValidatorJSON {
	// SAFETY: native validators expose runtime JSON omitted from public declarations.
	return (value as GenericValidator & { json: ValidatorJSON }).json
}
for (const [name, schema] of Object.entries({
	scalars: z.object({
		s: z.string(),
		n: z.number(),
		b: z.boolean(),
		i: z.bigint(),
		nil: z.null(),
		never: z.never(),
	}),
	ids: z.object({
		a: z.array(zid('items')),
		b: zid('items').nullable().optional(),
		c: z.union([zid('other').optional(), zid('items')]).nullable(),
	}),
	literals: z.object({ a: z.literal(['a', 'b']), b: z.literal(42), c: z.literal(null) }),
	variant: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('a'), a: z.string() }),
		z.object({ kind: z.literal('b'), b: z.number() }),
	]),
}))
	test(`U2 recipe-native differential ${name}`, () => {
		const recipe = captureDto(schema)
		const admission = classifyDto(recipe)
		expect(admission).toBeDefined()
		expect(json(admission!.emit())).toEqual(json(zodToConvex(materializeDto(recipe))))
	})
test('U2 eligibility is nonthrowing; optional-array emission retains conversion error', () => {
	const result = classifyDto(captureDto(z.object({ value: z.array(z.string().optional()) })))
	expect(result).toBeDefined()
	expect(() => result!.emit()).toThrow('Arrays of optional values are not supported')
})
test('U2 closed domain falls back for checks, hidden descendants, unknown keys and sparse arrays', () => {
	const extra = z.string()
	Reflect.set(extra._zod.def, 'extra', true)
	const sparse = z.union([z.string(), z.number()])
	Reflect.deleteProperty(sparse._zod.def.options, 0)
	for (const schema of [
		z.string().min(1),
		z.uuid(),
		zid('items').refine(() => true),
		extra,
		sparse,
		z.object({ a: z.string() }).catchall(z.uuid()),
	])
		expect(classifyDto(captureDto(schema))).toBeUndefined()
})
test('U2 configured hook and replacement memoizer select eager compatibility', () => {
	const recipe = captureDto(z.object({ a: z.string() }))
	const config = z.config()
	const old = config.postProcessor
	const memo = config.memoizer
	try {
		z.config({ postProcessor: () => {} })
		expect(classifyDto(recipe)).toBeUndefined()
		z.config({ postProcessor: old, memoizer: { ...memo! } })
		expect(classifyDto(recipe)).toBeUndefined()
	} finally {
		z.config({ postProcessor: old, memoizer: memo })
	}
})

test('U2 constructor configuration accessors are inspected without calling them', () => {
	const recipe = captureDto(z.object({ a: z.string() }))
	const config = z.config(),
		before = Object.getOwnPropertyDescriptor(config, 'memoizer')!
	let reads = 0
	Object.defineProperty(config, 'memoizer', {
		configurable: true,
		get() {
			reads++
			return before.value
		},
	})
	try {
		expect(classifyDto(recipe)).toBeUndefined()
		expect(reads).toBe(0)
	} finally {
		Object.defineProperty(config, 'memoizer', before)
	}
})
