// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vite-plus/test'
import { transformSource } from '../tools/codemod-v2/transform.mjs'
import { run } from '../tools/codemod-v2/index.mjs'
import { buildReport, formatSummary } from '../tools/codemod-v2/report.mjs'
const convert = (body) => transformSource('sample.ts', `import { z } from 'zod'\n${body}`)
const codes = (outcome) => outcome.skipped.map((site) => site.code)
function tree(files, body) {
	const root = mkdtempSync(join(tmpdir(), 'cvx-rc2-'))
	try {
		for (const [file, source] of Object.entries(files)) {
			const target = join(root, file)
			mkdirSync(join(target, '..'), { recursive: true })
			writeFileSync(target, source)
		}
		return body(root)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}
describe('codemod migration corrections', () => {
	it('reports foreign registration schemas and holds foreign object fields', () => {
		const result = transformSource(
			'foreign.ts',
			"import { effectZodApiBuilder } from 'cvx-kit/effect'; const query = effectZodApiBuilder(base, {}); import { credentialInput, paginationOpts } from '@x/pkg'\nimport { z } from 'zod'\nexport const get = query({ args: credentialInput, returns: credentialInput.nullable(), handler })\nconst input = z.object({ paginationOpts, unreadOnly: z.boolean().optional() })",
		)
		expect(codes(result)).toContain('zod-foreign-schema')
		expect(codes(result)).toContain('mixed-reference')
		expect(result.output).toContain('returns: credentialInput.nullable()')
		expect(result.output).toContain('const input = z.object(')
	})
	it('rewrites masks after shape element and unwrap and reports unknown receivers', () => {
		const result = convert(
			'const a = z.object({ lines: z.array(z.object({ frozen: z.boolean() })) }); const b = a.shape.lines.element.omit({ frozen: true }); const c = z.object({ x: z.string() }).optional(); const d = c.unwrap().pick({ x: true }); const e = other.shape.lines.element.omit({ frozen: true })',
		)
		expect(result.output).toContain("a.shape.lines.element.omit('frozen')")
		expect(result.output).toContain("c.unwrap().pick('x')")
		expect(codes(result)).toContain('unproven-mask')
	})
	it('rewrites table key-array type queries only in key positions', () => {
		const result = convert(
			"import { tenantTable } from 'cvx-kit/zod-table'\nconst fields = { status: z.string() }; const options = { serverFields: ['status'] as const }; const t = tenantTable<'t', typeof fields, typeof options.serverFields>('t', () => fields, options)",
		)
		expect(result.output).toContain(
			"tenantTable<'t', typeof fields, (typeof options.serverFields)[number]>",
		)
	})
	it('maps a closed generic schema helper when every call passes a migrated schema', () => {
		const result = convert(
			'function page<T extends z.ZodType>(row: T) { return z.strictObject({ page: z.array(row), isDone: z.boolean() }) }\nconst result = page(z.object({ name: z.string() }))',
		)
		expect(result.output).toContain('T extends AnyKSchema')
		expect(result.output).toContain('k.strictObject({ page: k.array(row)')
		expect(result.output).toContain("import type { AnyKSchema } from 'cvx-kit/k'")
		expect(codes(result)).not.toContain('zod-type')
		expect(
			codes(convert('export function page<T extends z.ZodType>(row: T) { return z.array(row) }')),
		).toContain('zod-type')
	})
	it('keeps default and catch factories and truthy refinements', () => {
		const result = convert(
			'const a = z.array(z.string()).default(() => []); const b = z.string().catch(() => "x"); const c = z.string().refine(s => s.match(/x/))',
		)
		expect(codes(result)).toEqual([])
		expect(result.output).toContain('k.array(k.string()).default(() => [])')
		expect(result.output).toContain('k.string().catch(() => "x")')
	})
	it.each([
		'async s => true',
		's => Promise.resolve(true)',
		'function(s) { return Promise.resolve(true) }',
	])('holds async refine %s', (callback) => {
		expect(codes(convert(`const a = z.string().refine(${callback})`))).toContain('refine-async')
	})
	it('reports changes to datetime normalization object unions and record keys', () => {
		const result = convert(
			'const date = z.iso.datetime(); const name = z.string().min(1).trim(); const choice = z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]); const map = z.record(z.string(), z.string())',
		)
		expect(result.info.map((site) => site.code)).toEqual(
			expect.arrayContaining([
				'iso-datetime-offset',
				'normalise-before-check',
				'union-member-order',
				'record-key-rule',
			]),
		)
	})
	it('maps string literal arrays to enums and holds other literal arrays', () => {
		expect(convert("const a = z.literal(['a', 'b'])").output).toContain("k.enum(['a', 'b'])")
		expect(codes(convert("const a = z.literal([1, 'b'])"))).toContain('literal-array')
	})
	it('holds unsupported factory parameter objects', () => {
		expect(
			codes(
				convert("const a = z.number({ error: 'need number' }); const b = z.string({ message })"),
			),
		).toEqual(['factory-params', 'factory-params'])
	})
	it.each([{ args: [] }, { args: ['src', '--bogus'] }, { args: ['/path-that-does-not-exist'] }])(
		'exits one for invalid CLI arguments %j',
		({ args }) => {
			expect(spawnSync(process.execPath, ['tools/codemod-v2/index.mjs', ...args]).status).toBe(1)
		},
	)
	it('prints fix text once per code and includes it in JSON', () => {
		const report = buildReport([
			convert('const a = z.lazy(() => z.string()); const b = z.lazy(() => z.string())'),
		])
		expect(report.codes.recursive).toBeTruthy()
		expect(formatSummary(report, false).split(report.codes.recursive)).toHaveLength(2)
	})
	it('removes a mask constant only when all references were rewritten', () => {
		const result = convert(
			'const mask = { tenant: true } as const; const a = z.object({ tenant: z.string() }); const b = a.omit(mask)',
		)
		expect(result.output).not.toContain('const mask')
		expect(
			convert(
				'export const mask = { tenant: true } as const; const a = z.object({ tenant: z.string() }); const b = a.omit(mask)',
			).output,
		).toContain('export const mask')
	})
	it('uses accurate report names', () => {
		expect(
			codes(
				convert(
					'const a = z.string().readonly(); const b = z.preprocess(x => x, z.string()); const c = z.object({}).catchall(z.string()); const d = z.file(); const e = z.templateLiteral([])',
				),
			),
		).toEqual(
			expect.arrayContaining(['readonly', 'preprocess', 'catchall', 'file', 'template-literal']),
		)
	})
	it('keeps mixed file classification stable after writing', () =>
		tree(
			{
				'package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
				'src/a.ts':
					"import { z } from 'zod'\nconst a = z.string(); const b = z.lazy(() => z.string())",
			},
			(root) => {
				const before = run(['src', '--write'], root)
				const source = readFileSync(join(root, 'src/a.ts'), 'utf8')
				const after = run(['src', '--write'], root)
				expect(after.report.summary.mixed).toBe(before.report.summary.mixed)
				expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe(source)
			},
		))
})

it('keeps report fix sentences synchronized with the migration guide', async () => {
	const { REPORT_FIXES } = await import('../tools/codemod-v2/report-codes.mjs')
	const guide = readFileSync('skills/cvx-kit/references/migration-v2.md', 'utf8')
	for (const [code, fix] of Object.entries(REPORT_FIXES)) {
		const row = guide.split('\n').find((line) => line.startsWith(`| \`${code}\``))
		expect(row, code).toBeTruthy()
		expect(row, code).toContain(fix)
	}
})
it('proves imports across the run before holding foreign schemas', () =>
	tree(
		{
			'package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
			'src/fields.ts': "import { z } from 'zod'\nexport const row = z.object({ id: z.string() })",
			'src/table.ts':
				"import { zodTable } from 'cvx-kit/zod-table'\nimport { row } from './fields'\nexport const rows = zodTable('rows', () => ({ value: row }))",
			'src/api.ts':
				"import { rows } from './table'\nexport const get = query({ args: rows.commandInput, returns: rows.dto(true).nullable(), handler })",
		},
		(root) => {
			const outcome = run(['src', '--write'], root)
			expect(outcome.report.totals['zod-foreign-schema']).toBeUndefined()
			expect(outcome.report.totals['mixed-reference']).toBeUndefined()
			expect(readFileSync(join(root, 'src/api.ts'), 'utf8')).toContain('get returns()')
		},
	))
it('proves exported schemas returned by a local factory', () =>
	tree(
		{
			'package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
			'src/fields.ts':
				"import { z } from 'zod'\nfunction text() { return z.string().min(1) }\nexport const row = text()",
			'src/use.ts':
				"import { z } from 'zod'\nimport { row } from './fields'\nexport const input = z.object({ row })",
		},
		(root) => {
			expect(run(['src'], root).report.totals['mixed-reference']).toBeUndefined()
		},
	))
it('holds extra factory options on object array literal and record factories', () => {
	for (const expression of [
		'z.object({}, { error: "x" })',
		'z.array(z.string(), { error: "x" })',
		'z.literal("a", { error: "x" })',
		'z.record(z.string(), z.string(), { error: "x" })',
	]) {
		expect(codes(convert(`const input = ${expression}`))).toContain('factory-params')
	}
})
it('reports table type queries that are not proven key arrays', () => {
	const result = convert(
		"import { tenantTable } from 'cvx-kit/zod-table'\nconst fields = { status: z.string() }; const server = 'status'; const t = tenantTable<'t', typeof fields, typeof server>('t', () => fields)",
	)
	expect(codes(result)).toContain('table-type-arguments')
	expect(result.output).not.toContain('(typeof server)[number]')
})
it('maps a generic object constraint when its shape is unconstrained', () => {
	const result = convert(
		'function page<T extends z.ZodObject<z.ZodRawShape>>(row: T) { return z.object({ page: z.array(row) }) }\nconst result = page(z.object({ name: z.string() }))',
	)
	expect(result.output).toContain('T extends KObject<KFields>')
	expect(codes(result)).not.toContain('zod-type')
})
it('holds a helper together with a caller passing a held schema', () => {
	const result = convert(
		'function page<T extends z.ZodType>(row: T) { return z.array(row) }\nconst row = z.lazy(() => z.string()); const result = page(row)',
	)
	expect(result.output).toContain('T extends z.ZodType')
	expect(result.output).not.toContain('AnyKSchema')
})
it('rewrites masks on inline kit schemas and reports an unknown table projection', () => {
	const result = transformSource(
		'inline.ts',
		"import { k } from 'cvx-kit'\nimport { kTable } from 'cvx-kit/table'\nconst a = k.object({ lines: k.array(k.object({ frozen: k.boolean() })) }).shape.lines.element.omit({ frozen: true }); const table = kTable('t', { id: k.string() }); const b = table.unknown.omit({ id: true })",
	)
	expect(result.output).toContain(".shape.lines.element.omit('frozen')")
	expect(codes(result)).toContain('unproven-mask')
})
it('prints a fix once per strict restoration report code', async () => {
	const { formatRestoreSummary } = await import('../tools/codemod-v2/restore-strict.mjs')
	const { REPORT_FIXES } = await import('../tools/codemod-v2/report-codes.mjs')
	const summary = formatRestoreSummary(
		[
			{
				path: 'a.ts',
				restored: 0,
				already: 0,
				manual: [
					{ code: 'strict-unpaired', baseLine: 1, message: 'unpaired' },
					{ code: 'strict-unpaired', baseLine: 2, message: 'unpaired' },
				],
			},
		],
		'base',
		false,
	)
	expect(summary.split(REPORT_FIXES['strict-unpaired'])).toHaveLength(2)
})
it('reuses an existing helper schema type import', () => {
	const result = convert(
		"import type { AnyKSchema } from 'cvx-kit/k'\nfunction page<T extends z.ZodType>(row: T) { return z.array(row) }\nconst result = page(z.string())",
	)
	expect(result.output.match(/import type \{ AnyKSchema \}/g)).toHaveLength(1)
})
it('keeps mixed status when the remaining Zod is only a type helper', () => {
	const first = convert(
		"import { foreign } from '@x/pkg'\nconst good = z.string(); type Output = z.infer<typeof foreign>",
	)
	const second = transformSource('sample.ts', first.output)
	expect(first.status).toBe('mixed')
	expect(second.status).toBe('mixed')
	expect(second.output).toBe(first.output)
})

it('proves exported migrated ids before rewriting their importers', () =>
	tree(
		{
			'package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
			'src/ids.ts': "import { zid } from 'cvx-kit/zod-table'\nexport const id = zid('rows')",
			'src/input.ts':
				"import { z } from 'zod'\nimport { id } from './ids'\nexport const input = z.object({ id: id.optional() })\nexport type Input = z.infer<typeof input>",
		},
		(root) => {
			const first = run(['src', '--write'], root)
			expect(first.report.totals['mixed-reference']).toBeUndefined()
			const source = readFileSync(join(root, 'src/input.ts'), 'utf8')
			expect(source).toContain('k.object(')
			expect(run(['src', '--write'], root).report.declarations.rewritten).toBe(0)
			expect(readFileSync(join(root, 'src/input.ts'), 'utf8')).toBe(source)
		},
	))

it('does not classify generated normalization callbacks as held Zod on a rerun', () => {
	const first = convert(
		"export const name = z.string().normalize('NFKC'); export const input = z.object({ name })",
	)
	const second = transformSource('sample.ts', first.output)
	expect(second.output).toBe(first.output)
	expect(codes(second)).toEqual([])
	expect(second.declarations.left).toBe(0)
	expect(second.status).toBe('untouched')
})

it('keeps Zod-only classification stable after moving a held zid import', () => {
	const first = convert(
		"import { zid } from 'cvx-kit/zod-table'\nconst input = z.object({ id: zid('rows'), pair: z.lazy(() => z.string()) })",
	)
	const second = transformSource('sample.ts', first.output)
	expect(first.status).toBe('kept')
	expect(second.status).toBe(first.status)
	expect(second.output).toBe(first.output)
})

describe('codemod conservative alias and helper handling', () => {
	it.each([
		'export { mask }',
		'export { mask as x }',
		'export default mask',
		'type Mask = typeof mask',
	])('preserves masks referenced by %s', (reference) => {
		const result = convert(
			`const mask={a:true} as const; const a=z.object({a:z.string()}).pick(mask); ${reference}`,
		)
		expect(result.output).toContain('const mask=')
	})
	it.each([
		'schema.isOptional()',
		'schema.parseAsync("x")',
		'value.isOptional()',
		'schema.optional().parseAsync("x")',
	])('holds generic helper with unsupported member %s', (body) => {
		const result = convert(
			`function helper<T extends z.ZodType>(schema:T) { const value:T = schema; return ${body} }; helper(z.string())`,
		)
		expect(codes(result)).toContain('zod-type')
		expect(result.output).toContain('T extends z.ZodType')
	})
	it('holds unsupported members on inferred generic aliases', () => {
		const result = convert(
			`function helper<T extends z.ZodType>(schema:T) { const value = schema; return value.isOptional() }; helper(z.string())`,
		)
		expect(codes(result)).toContain('zod-type')
	})
	it('allows tuple members proved to be kit schemas when their structure is unresolved', () => {
		tree(
			{
				'package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
				'member.ts': "import { k } from 'cvx-kit'; export const member=k.array(k.string()).element",
				'use.ts':
					"import { z } from 'zod'; import { member } from './member'; const a=z.tuple([member])",
			},
			(root) => {
				const result = run(['use.ts', 'member.ts', '--write'], root)
				const use = result.report.files.find((file) => file.path.endsWith('use.ts'))
				expect(codes(use)).not.toContain('tuple-optionality')
				expect(readFileSync(join(root, 'use.ts'), 'utf8')).toContain('k.tuple([member])')
			},
		)
	})
	it('resolves constant literal arrays and scalar constants', () => {
		const result = convert(
			`const values=['a','b'] as const; const scalar='a'; const a=z.literal(values); const b=z.literal(scalar)`,
		)
		expect(result.output).toContain('k.enum(values)')
		expect(result.output).toContain('k.literal(scalar)')
	})
	it.each(['unknownValue', 'values', '[dynamic]'])('holds unproven literal values %s', (value) => {
		expect(codes(convert(`const values=[1,'b'] as const; const a=z.literal(${value})`))).toContain(
			'literal-array',
		)
	})
	it('holds foreign schemas reached through local aliases', () => {
		const result = convert(
			`import { foreign } from './foreign'; const alias = foreign; const a=z.object({ a: alias })`,
		)
		expect(codes(result)).toContain('mixed-reference')
		expect(result.output).toContain('z.object({ a: alias })')
	})
	it.each(['args', 'returns'])(
		'holds foreign schemas in a registration %s field map',
		(property) => {
			const result = convert(
				`import { effectZodApiBuilder } from 'cvx-kit/effect'; const query = effectZodApiBuilder(base, {}); import { foreign } from './foreign'; const alias = foreign; const a=query({ ${property}: { a: alias }, handler })`,
			)
			expect(codes(result)).toContain('zod-foreign-schema')
			expect(result.output).toContain(`${property}: { a: alias }`)
		},
	)
	it('holds table callbacks when later arguments change evaluation order', () => {
		const result = convert(
			`import { zodTable } from 'cvx-kit/zod-table'; const t=zodTable('t', () => { const s = z.string().min(minimum); return { s } }, (minimum = 5, {}))`,
		)
		expect(codes(result)).toContain('table-callback-complex')
		expect(result.output).toContain('const s = z.string().min(minimum)')
	})
	it.each(['export { helper }', 'export { helper as other }', 'export default helper'])(
		'holds a generic helper exported with %s',
		(exported) => {
			const result = convert(
				`function helper<T extends z.ZodType>(schema:T) { return z.array(schema) }; helper(z.string()); ${exported}`,
			)
			expect(codes(result)).toContain('zod-type')
		},
	)
	it.each(["z.string().default('x')", 'member'])('holds defaulted tuple member %s', (member) => {
		const result = convert(`const member=z.string().default('x'); const a=z.tuple([${member}])`)
		expect(codes(result)).toContain('tuple-optionality')
	})
	it('reports normalization after checks through constant aliases', () => {
		const result = convert(`const base=z.string().min(1); const alias=base; const a=alias.trim()`)
		expect(result.info.map((site) => site.code)).toContain('normalise-before-check')
	})
	it('reports object union ordering through a constant array', () => {
		const result = convert(
			`const members=[z.object({a:z.string()}),z.object({b:z.string()})] as const; const a=z.union(members)`,
		)
		expect(result.info.map((site) => site.code)).toContain('union-member-order')
	})
})

describe('foreign schema report boundaries', () => {
	it('leaves an unmigrated local builder alone without foreign reports or getters', () => {
		const source =
			"import { query } from './functions'; import { foreign } from '@sdk/contracts'; export const get = query({ args: foreign, returns: foreign.nullable(), handler })"
		const result = transformSource('api.ts', source)
		expect(codes(result)).not.toContain('zod-foreign-schema')
		expect(result.output).toBe(source)
		expect(result.declarations.left).toBe(0)
	})
	it('reports a mixed unknown registration once per property without counting foreign declarations', () => {
		const result = convert(
			"import { foreign } from '@sdk/contracts'; export const get = query({ args: { a: foreign, b: foreign.shape.b }, returns: z.string(), handler })",
		)
		expect(result.skipped.filter((site) => site.code === 'zod-foreign-schema')).toHaveLength(1)
		const onlyForeign = transformSource(
			'api.ts',
			"import { effectZodApiBuilder } from 'cvx-kit/effect'; import { foreign } from '@sdk/contracts'; const query = effectZodApiBuilder(base, {}); export const get = query({ args: foreign, returns: foreign.nullable(), handler })",
		)
		expect(onlyForeign.skipped.filter((site) => site.code === 'zod-foreign-schema')).toHaveLength(2)
		expect(onlyForeign.declarations.left).toBe(0)
		expect(onlyForeign.output).toContain('returns: foreign.nullable()')
	})
	it('proves migrated local shape maps and computed member schemas across the run', () =>
		tree(
			{
				'package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
				'src/fields.ts':
					"import { z } from 'zod'; export const input = z.object({ name: z.string() }); export const other = z.object({ name: input['shape'].name.optional() })",
				'src/functions.ts':
					"import { effectZodApiBuilder } from 'cvx-kit/effect'; export const query = effectZodApiBuilder(base, {})",
				'src/api.ts':
					"import { query } from './functions'; import { input, other } from './fields'; export const get = query({ args: input.shape, returns: other, handler })",
			},
			(root) => {
				const result = run(['src', '--write'], root)
				expect(result.report.totals['zod-foreign-schema']).toBeUndefined()
				expect(result.report.totals['mixed-reference']).toBeUndefined()
				expect(readFileSync(join(root, 'src/fields.ts'), 'utf8')).toContain(
					"input['shape'].name.optional()",
				)
				expect(readFileSync(join(root, 'src/fields.ts'), 'utf8')).toContain('k.object')
			},
		))
	it('reports a foreign kit contract entry once and ignores ordinary schema uses', () => {
		const result = transformSource(
			'contract.ts',
			"import { defineDomainContract } from 'cvx-kit/contracts'; import { foreign } from '@sdk/contracts'; const contract = defineDomainContract({ queries: { list: { input: foreign, result: foreign.nullable() } } }); foreign.parse(value); foreign.safeParse(value); consume(foreign); type Value = typeof foreign",
		)
		expect(result.skipped.filter((site) => site.code === 'zod-foreign-schema')).toHaveLength(2)
		expect(result.declarations.left).toBe(0)
	})
})

it('reports migrated namespace builders and contract wrappers without handlers', () => {
	const result = transformSource(
		'api.ts',
		"import * as kit from 'cvx-kit/effect'; import { zodContract } from 'cvx-kit/contracts'; import { foreign } from '@sdk/contracts'; const query = kit.effectZodApiBuilder(base, {}); export const get = query({ args: foreign, handler }); const contract = zodContract({ args: foreign, returns: foreign })",
	)
	expect(result.skipped.filter((site) => site.code === 'zod-foreign-schema')).toHaveLength(3)
})

it('does not report schemas on native effect builders that the run leaves native', () =>
	tree(
		{
			'package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
			'src/functions.ts':
				"import { effectApiBuilder } from 'cvx-kit/effect'; export const action = effectApiBuilder(base, {})",
			'src/native.ts': "import { v } from 'convex/values'; export const result = v.string()",
			'src/api.ts':
				"import { action } from './functions'; import { result } from './native'; export const run = action({ returns: result, handler })",
		},
		(root) => expect(run(['src'], root).report.totals['zod-foreign-schema']).toBeUndefined(),
	))

it('follows exported destructured kit builders through a local module', () =>
	tree(
		{
			'package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
			'src/functions.ts':
				"import { createEffectAuthFunctions } from 'cvx-kit/effect'; export const { query } = createEffectAuthFunctions(config, {})",
			'src/api.ts':
				"import { query } from './functions'; import { foreign } from '@sdk/contracts'; export const get = query({ args: { a: foreign }, handler })",
		},
		(root) => expect(run(['src'], root).report.totals['zod-foreign-schema']).toBe(1),
	))
