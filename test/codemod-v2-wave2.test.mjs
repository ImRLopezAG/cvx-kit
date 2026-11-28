// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vite-plus/test'
import { transformSource } from '../tools/codemod-v2/transform.mjs'
import { run } from '../tools/codemod-v2/index.mjs'
const convert = (body) => transformSource('sample.ts', `import { z } from 'zod'\n${body}`)
const codes = (outcome) => outcome.skipped.map((site) => site.code)

describe('codemod scalar and tuple forms', () => {
	it('maps formats, numeric checks and never while preserving messages and zero normalization', () => {
		const result = convert(`const a = z.ipv4(); const b = z.ipv6(); const c = z.uuid();
const d = z.string().ipv4({ error: 'address' }).ipv6().uuid();
const e = z.number().gt(2, { error: 'low' }).lt(10).multipleOf(0.05, 'price');
const f = z.never(); const g = z.number().gt(0).lt(0);`)
		expect(codes(result)).toEqual([])
		expect(result.output).toContain('k.ipv4()')
		expect(result.output).toContain('k.ipv6()')
		expect(result.output).toContain('k.uuid()')
		expect(result.output).toContain("k.string().ipv4({ message: 'address' }).ipv6().uuid()")
		expect(result.output).toContain(
			"k.number().finite().gt(2, { message: 'low' }).lt(10).multipleOf(0.05, 'price')",
		)
		expect(result.output).toContain('k.never()')
		expect(result.output).toContain('k.number().finite().positive().negative()')
		expect(codes(transformSource('sample.ts', result.output))).toEqual([])
	})
	it.each(['z.ipv4({})', 'z.ipv6("message")', 'z.uuid({ version: "v4" })'])(
		'holds factory options %s',
		(schema) => {
			expect(codes(convert(`const a = ${schema}`))).toContain('factory-params')
		},
	)
	it.each(['z.string().uuid({ version: "v4" })', 'z.string().ipv4({ abort: true })'])(
		'holds unsupported chain options %s',
		(schema) => {
			expect(codes(convert(`const a = ${schema}`))).toContain('string-format')
		},
	)
	it.each(['0', '-2', 'NaN', 'Infinity', '-Infinity'])('holds invalid multipleOf %s', (divisor) => {
		const result = convert(`const a = z.number().multipleOf(${divisor})`)
		expect(codes(result)).toContain('multiple-of-divisor')
		expect(result.output).toContain('z.number()')
	})
	it('maps fixed, empty, nested and rest tuples with required aliases', () => {
		const result = convert(`const member = z.string(); const a = z.tuple([member, z.number()]);
const b = z.tuple([]); const c = z.tuple([z.tuple([member])], z.boolean());
const d = z.tuple([member]).rest(z.string());
const f = z.tuple([z.object({ label: z.string() }).partial()]);`)
		expect(codes(result)).toEqual([])
		expect(result.output).toContain('k.tuple([member, k.number().finite()])')
		expect(result.output).toContain('k.tuple([])')
		expect(result.output).toContain('k.tuple([k.tuple([member])], k.boolean())')
		expect(result.output).toContain('k.tuple([member]).rest(k.string())')
		expect(transformSource('sample.ts', result.output).output).toBe(result.output)
	})
	it('keeps rest directly on an unchecked tuple and holds checked receivers', () => {
		expect(codes(convert('const a = z.tuple([]).refine(() => true).rest(z.string())'))).toContain(
			'tuple-arguments',
		)
	})
	it.each(['z.string().optional()', 'z.void()', 'maybe'])(
		'holds unsupported tuple slots %s atomically',
		(member) => {
			const result = convert(
				`const maybe = z.string().optional(); const a = z.object({ pair: z.tuple([${member}]), name: z.string() })`,
			)
			expect(codes(result)).toContain('tuple-optionality')
			expect(result.output).toContain('const a = z.object(')
		},
	)
	it.each(['items', '[...items]', '[foreign]', '[z.string()], z.boolean(), {}'])(
		'holds unproven tuple arguments %s',
		(args) => {
			const result = convert(`const a = z.tuple(${args})`)
			expect(codes(result)).toContain('tuple-arguments')
			expect(result.output).toContain('z.tuple(')
		},
	)
	it('keeps recursive declarations intact with a concrete manual fix', () => {
		const input = 'const a = z.object({ name: z.string(), children: z.lazy(() => z.array(a)) })'
		const result = convert(input)
		expect(codes(result)).toContain('recursive')
		expect(result.output).toContain(input)
	})
})

describe('codemod scoped table callbacks', () => {
	const table = (body) =>
		convert(`import { zodTable } from 'cvx-kit/zod-table'\nconst t = zodTable('t', ${body})`)
	it('keeps const declarations and a late field return inside an IIFE', () => {
		const result = table(
			`(id) => { const nested = z.object({ item: id('items') }); const fields = { nested }; return fields }`,
		)
		expect(codes(result)).toEqual([])
		expect(result.output).toContain(
			"kTable('t', (() => { const nested = k.object({ item: k.id('items') }); const fields = { nested }; return fields })())",
		)
		expect(transformSource('sample.ts', result.output).output).toBe(result.output)
	})
	it('preserves callback-local evaluation order and shadowed parameters', () => {
		const result = table(
			`(id) => { const nested = z.string().default(() => sideEffect()); const other = z.string().refine((id) => id.length > 0); return { nested, other, owner: id('owners') } }`,
		)
		expect(codes(result)).toEqual([])
		expect(result.output).toContain('.default(() => sideEffect())')
		expect(result.output).toContain('.refine((id) => id.length > 0)')
		expect(result.output).toContain("owner: k.id('owners')")
	})
	it('holds callbacks with side-effecting options', () => {
		const result = table(
			`(id) => { const limit = (mark('limit'), 1); const nested = z.string().min(limit); return { nested, owner: id('owners') } }, mark('options')`,
		)
		expect(codes(result)).toContain('table-callback-complex')
		expect(result.output).toContain("mark('options')")
	})

	it('moves a callback past options that only spread plain references', () => {
		const result = table(
			`(id) => { const nested = z.string(); return { nested, owner: id('owners') } }, { indexes: [...base.indexes, ['byOwner', ['owner']]], ...shared }`,
		)
		expect(codes(result)).not.toContain('table-callback-complex')
		expect(result.output).toContain("owner: k.id('owners')")
	})

	it.each([
		`(id) => { const alias = id; return { x: alias('x') } }`,
		`(id) => { const x = id(variable); return { x } }`,
		`(id) => { const x = id('x', 'extra'); return { x } }`,
		`(id) => { let x = z.string(); return { x } }`,
		`(id) => { if (flag) return {}; return { x: z.string() } }`,
		`async (id) => { return { x: z.string() } }`,
		`({ id }) => ({ x: z.string() })`,
		`(id = makeId()) => ({ x: z.string() })`,
		`(...id) => ({ x: z.string() })`,
		`(id) => { const { x } = source; return { x: z.string() } }`,
		`(id) => { const x = z.string(); id = other; return { x } }`,
		`() => { const fields = { x: unknownSchema }; return fields }`,
	])('holds callbacks outside the proven subset: %s', (body) => {
		const result = table(body)
		expect(codes(result)).toContain('table-callback-complex')
		expect(result.output).toContain(body)
	})
	it('holds k shadowing and unsupported nested schemas without partial edits', () => {
		expect(codes(table(`(id) => { const k = 1; return { x: id('x') } }`))).toContain('k-shadowed')
		const body = `(id) => { const nested = z.object({ x: z.lazy(() => z.string()) }); return { nested, owner: id('x') } }`
		const result = table(body)
		expect(codes(result)).toContain('recursive')
		expect(result.output).toContain(body)
	})
})

describe('codemod kit table schema provenance', () => {
	it('recognizes imported tables and relation table members without trusting arbitrary objects', () => {
		const root = mkdtempSync(join(tmpdir(), 'cvx-wave2-'))
		try {
			mkdirSync(join(root, 'src'))
			for (const [name, source] of Object.entries({
				'package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
				'src/tables.ts':
					"import { z } from 'zod'; import { zodTable } from 'cvx-kit/zod-table'; export const offices = zodTable('offices', { name: z.string() })",
				'src/relations.ts':
					"import { defineRelations } from 'cvx-kit/relations'; import { offices } from './tables'; export const relations = defineRelations({ offices }, {})",
				'src/slots.ts':
					"import { z } from 'zod'; export const required = z.string(); export const maybe = z.string().optional()",
				'src/barrel.ts':
					"export { offices } from './tables'; export { relations } from './relations'; export { required, maybe } from './slots'",
				'src/tuples.ts':
					"import { z } from 'zod'; import { required, maybe } from './barrel'; export const a = z.tuple([required]); export const b = z.tuple([maybe]); export const c = z.tuple([]).rest(maybe)",
				'src/use.ts':
					"import { effectZodApiBuilder } from 'cvx-kit/effect'; const query = effectZodApiBuilder(base, {}); import { offices, relations } from './barrel'; import { other } from './external'; export const a = query({ args: offices.paginationOpts({}), returns: relations.tables.offices.pageDto({}), handler }); export const b = query({ args: offices.schema, returns: offices.dto({}), handler }); export const c = query({ args: other.paginationOpts({}), handler })",
			}))
				writeFileSync(join(root, name), source)
			const result = run(['src'], root)
			const use = result.report.files.find((file) => file.path.endsWith('src/use.ts'))
			expect(use.skipped.filter((site) => site.code === 'zod-foreign-schema')).toHaveLength(1)
			expect(use.skipped.find((site) => site.code === 'zod-foreign-schema').text).toBe(
				'other.paginationOpts({})',
			)
			const tuples = result.report.files.find((file) => file.path.endsWith('src/tuples.ts'))
			expect(tuples.declarations).toEqual({ rewritten: 1, left: 2 })
			expect(tuples.skipped.filter((site) => site.code === 'tuple-optionality')).toHaveLength(2)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})
