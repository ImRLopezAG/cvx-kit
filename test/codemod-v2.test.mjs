// @vitest-environment node
import { spawnSync } from 'node:child_process'
import {
	cpSync,
	existsSync,
	symlinkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { HELP, parseArguments, run } from '../tools/codemod-v2/index.mjs'
import { createSourceResolver } from '../tools/codemod-v2/resolve.mjs'
import { transformSource } from '../tools/codemod-v2/transform.mjs'

const FIXTURES = 'tools/codemod-v2/fixtures'
const CLI = 'tools/codemod-v2/index.mjs'
const cases = readdirSync(FIXTURES).sort()
// Kept out of the fixture tree so lint does not parse an intentionally broken file.
const BROKEN = "import { z } from 'zod'\n\nexport const Broken = z.strictObject({ a: z.string( })\n"

function fixture(name, file) {
	return readFileSync(join(FIXTURES, name, file), 'utf8')
}

function withTempTree(files, body) {
	const root = mkdtempSync(join(tmpdir(), 'cvx-codemod-'))
	try {
		for (const [path, target] of Object.entries(files)) {
			cpSync(path, join(root, target), { recursive: true })
		}
		mkdirSync(join(root, 'src'), { recursive: true })
		writeFileSync(join(root, 'src/broken.ts'), BROKEN)
		return body(root)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

describe('codemod-v2 fixtures', () => {
	it.each(cases)('%s rewrites to expected.ts', (name) => {
		const outcome = transformSource(`${name}/input.ts`, fixture(name, 'input.ts'))
		expect(outcome.output).toBe(fixture(name, 'expected.ts'))
		const reportPath = join(FIXTURES, name, 'expected.report.json')
		if (!existsSync(reportPath)) {
			expect(outcome.skipped).toEqual([])
			return
		}
		const expected = JSON.parse(readFileSync(reportPath, 'utf8'))
		expect(outcome.status).toBe(expected.status)
		expect(outcome.skipped.map(({ line, code }) => ({ line, code }))).toEqual(expected.skipped)
		if (expected.declarations) expect(outcome.declarations).toEqual(expected.declarations)
		if (expected.info)
			expect(outcome.info.map(({ line, code }) => ({ line, code }))).toEqual(expected.info)
	})

	it.each(cases)('%s is idempotent', (name) => {
		const expected = fixture(name, 'expected.ts')
		expect(transformSource(`${name}/expected.ts`, expected).output).toBe(expected)
	})

	it('reports skipped sites with line, column and the first 80 characters', () => {
		const outcome = transformSource('not-rewritten.ts', fixture('not-rewritten', 'input.ts'))
		expect(outcome.skipped[0]).toEqual({
			line: 3,
			column: 59,
			code: 'catchall',
			text: 'catchall(z.string())',
		})
		expect(outcome.skipped.every((site) => site.text.length <= 80)).toBe(true)
	})

	it('reports a file that does not parse as error and leaves it unchanged', () => {
		const outcome = transformSource('broken.ts', BROKEN)
		expect(outcome.status).toBe('error')
		expect(outcome.output).toBe(BROKEN)
		expect(outcome.error).toBeTruthy()
	})

	it('preserves object parse policies without informational strictness reports', () => {
		const input =
			"import { z } from 'zod'\nconst A = z.object({ a: z.string() }); A.parse({ a: 'x', extra: 1 });\nconst B = z.strictObject({}); const C = z.object({}).strict();\n"
		const outcome = transformSource('policies.ts', input)
		expect(outcome.output).toContain('const A = k.object({ a: k.string() })')
		expect(outcome.output).not.toContain('.strip()')
		expect(outcome.output).toContain('const B = k.strictObject({})')
		expect(outcome.output).toContain('const C = k.object({}).strict()')
		expect(outcome.info).toEqual([])
	})
})

describe('codemod-v2 number bounds', () => {
	const source = [
		"import { z } from 'zod'",
		'',
		'export const Payment = z.object({',
		'	cents: z.int().positive(),',
		'	units: z.number().int(),',
		'	before: z.number(),',
		'	floor: z.number().min(0),',
		'	rate: z.number().finite(),',
		'	safe: z.int().safe(),',
		'	legacy: z.number().safe(),',
		'	chained: z.number().int().safe(),',
		'})',
		'',
	].join('\n')

	it("keeps v1's refusals by default and reports them as informational", () => {
		const outcome = transformSource('payment.ts', source)
		expect(outcome.output).toContain('\tcents: k.int().positive(),')
		expect(outcome.output).toContain('\tunits: k.int(),')
		expect(outcome.output).toContain('\tbefore: k.number().finite(),')
		expect(outcome.output).toContain('\tfloor: k.number().finite().min(0),')
		expect(outcome.output).toContain('\trate: k.number().finite(),')
		expect(outcome.output).toContain('\tsafe: k.int(),')
		expect(outcome.output).toContain('\tlegacy: k.int(),')
		expect(outcome.output).toContain('\tchained: k.int(),')
		expect(outcome.info.map((site) => site.code)).toEqual([
			'number-finite-preserved',
			'number-finite-preserved',
		])
		expect(outcome.status).toBe('rewritten')
		expect(transformSource('payment.ts', outcome.output).output).toBe(outcome.output)
	})

	it('omits only finite-number checks with --native-number-bounds', () => {
		const outcome = transformSource('payment.ts', source, { nativeNumberBounds: true })
		expect(outcome.output).toContain('\tcents: k.int().positive(),')
		expect(outcome.output).toContain('\tunits: k.int(),')
		expect(outcome.output).toContain('\tbefore: k.number(),')
		expect(outcome.output).toContain('\tfloor: k.number().min(0),')
		expect(outcome.output).toBe(
			transformSource('payment.ts', source)
				.output.replaceAll('k.number().finite().min(0)', 'k.number().min(0)')
				.replace('before: k.number().finite()', 'before: k.number()'),
		)
		expect(outcome.info.map((site) => site.code)).toEqual([
			'number-now-accepts-nan',
			'number-now-accepts-nan',
		])
	})

	it('normalizes safe integers on numeric aliases and preserves check options', () => {
		const input =
			"import { z } from 'zod'\nconst n = z.number(); const i = z.int();\nconst A = n.safe({ error: 'integer' }); const B = i.safe({ error: 'redundant' });\nconst C = z.int().safe({ error: 'redundant' }); const D = z.number().safe({ error: 'integer' });\n"
		const outcome = transformSource('aliases.ts', input)
		expect(outcome.status).toBe('rewritten')
		expect(outcome.output).toContain("const A = n.int({ message: 'integer' })")
		expect(outcome.output).toContain('const B = i;')
		expect(outcome.output).toContain('const C = k.int();')
		expect(outcome.output).toContain("const D = k.number().int({ message: 'integer' })")
		expect(outcome.output).not.toContain('.safe(')
		expect(transformSource('aliases.ts', outcome.output).output).toBe(outcome.output)
	})

	it('accepts the flag on the command line and documents it in --help', () => {
		expect(parseArguments(['src', '--native-number-bounds']).nativeNumberBounds).toBe(true)
		expect(parseArguments(['src']).nativeNumberBounds).toBe(false)
		expect(HELP).toContain('--native-number-bounds')
		expect(HELP).toContain('number-now-accepts-nan')
	})
})

describe('codemod-v2 function getters', () => {
	const source = [
		"import { z } from 'zod'",
		"import { queryGeneric as authQuery } from 'convex/server'",
		'',
		'export const get = authQuery({',
		'\targs: z.strictObject({ id: z.string() }),',
		'\treturns: shared.result,',
		'\thandler: async () => null,',
		'})',
		'',
	].join('\n')

	it('turns a non-reference args value into a getter and keeps cheap references', () => {
		const { output } = transformSource('fn.ts', source)
		expect(output).toContain('\tget args() { return k.strictObject({ id: k.string() }) },')
		expect(output).toContain('\treturns: shared.result,')
	})

	it('keeps data properties with getters: false', () => {
		const { output } = transformSource('fn.ts', source, { getters: false })
		expect(output).toContain('\targs: k.strictObject({ id: k.string() }),')
		expect(output).not.toContain('get args()')
	})

	it('leaves values that read this, await or yield, and objects without a handler', () => {
		const input = [
			"import { z } from 'zod'",
			"import { queryGeneric as authQuery } from 'convex/server'",
			'function configure(value) { return value }',
			'',
			'export const a = authQuery({ args: this.args(), handler: () => null })',
			'export const b = authQuery({ args: await load(), handler: () => null })',
			'export const c = configure({ args: z.string() })',
			'export const d = authQuery({ get args() { return z.string() }, handler: () => null })',
			'',
		].join('\n')
		const { output } = transformSource('fn.ts', input)
		expect(output).toContain('{ args: this.args(), handler')
		expect(output).toContain('{ args: await load(), handler')
		expect(output).toContain('configure({ args: k.string() })')
		expect(output).toContain('{ get args() { return k.string() }, handler')
	})
})

describe('codemod-v2 CLI', () => {
	const tree = {
		[join(FIXTURES, 'strict-object/input.ts')]: 'src/strict.ts',
		[join(FIXTURES, 'mixed-file/input.ts')]: 'src/mixed.ts',
		[join(FIXTURES, 'keep-marker/input.ts')]: 'src/kept.ts',
		[join(FIXTURES, 'factories/input.ts')]: 'src/_generated/api.ts',
		[join(FIXTURES, 'types/input.ts')]: 'src/types.d.ts',
	}

	it('dry run writes nothing, keeps going past a syntax error and prints totals only', () => {
		withTempTree(tree, (root) => {
			const before = readFileSync(join(root, 'src/strict.ts'), 'utf8')
			const reportFile = join(root, 'report.json')
			const printed = spawnSync('node', [join(process.cwd(), CLI), 'src', '--report', reportFile], {
				cwd: root,
				encoding: 'utf8',
			})
			// The broken file fails the run (exit 1) after the report is written.
			expect(printed.status).toBe(1)
			expect(printed.stdout).toContain('dry run')
			expect(printed.stdout).not.toContain('strict.ts')
			expect(readFileSync(join(root, 'src/strict.ts'), 'utf8')).toBe(before)
			const report = JSON.parse(readFileSync(reportFile, 'utf8'))
			expect(report.summary).toEqual({
				scanned: 4,
				rewritten: 1,
				mixed: 1,
				kept: 1,
				untouched: 0,
				error: 1,
			})
			expect(report.files.find((file) => file.path.endsWith('broken.ts')).status).toBe('error')
			expect(report.totals).toEqual({ 'keep-zod-marker': 1, tuple: 1 })
			expect(report.declarations).toEqual({ rewritten: 4, left: 2 })
			expect(report.mechanicalShare).toBe(0.6667)
		})
	})

	it('--write rewrites in place and a second run changes nothing', () => {
		withTempTree(tree, (root) => {
			run(['src', '--write', '--ignore', 'src/broken.ts'], root)
			expect(readFileSync(join(root, 'src/strict.ts'), 'utf8')).toBe(
				fixture('strict-object', 'expected.ts'),
			)
			expect(readFileSync(join(root, 'src/mixed.ts'), 'utf8')).toBe(
				fixture('mixed-file', 'expected.ts'),
			)
			expect(readFileSync(join(root, 'src/_generated/api.ts'), 'utf8')).toBe(
				fixture('factories', 'input.ts'),
			)
			const second = run(['src', '--write', '--ignore', 'src/broken.ts'], root).report
			expect(second.summary.rewritten).toBe(0)
			expect(second.files.find((file) => file.path.endsWith('mixed.ts')).status).toBe('mixed')
			expect(second.declarations).toEqual({ rewritten: 0, left: 2 })
			const secondCli = spawnSync(
				'node',
				[join(process.cwd(), CLI), 'src', '--ignore', 'src/broken.ts'],
				{ cwd: root, encoding: 'utf8' },
			)
			expect(secondCli.status).toBe(0)
			expect(secondCli.stdout).toContain('0 rewritten, 1 mixed')
			expect(secondCli.stdout).toContain('declarations: 0 rewritten, 2 left as Zod')
		})
	})

	it('honours --ext', () => {
		withTempTree({ [join(FIXTURES, 'strict-object/input.ts')]: 'src/schema.mts' }, (root) => {
			expect(run(['src', '--ext', 'ts'], root).report.summary.scanned).toBe(1)
			expect(run(['src', '--ext', 'mts'], root).report.summary.rewritten).toBe(1)
		})
	})

	it('--no-getters keeps function args as data properties', () => {
		withTempTree({ [join(FIXTURES, 'function-getters/input.ts')]: 'src/fn.ts' }, (root) => {
			run(['src/fn.ts', '--write', '--no-getters'], root)
			const output = readFileSync(join(root, 'src/fn.ts'), 'utf8')
			expect(output).not.toContain('get args()')
			expect(output).toContain('args: relations.tables.notes.paginationOpts({ title: true }),')
		})
	})

	it('rejects unknown options', () => {
		expect(() => run(['src', '--force'])).toThrow('Unknown option --force')
	})

	it('reports the keep marker only as the start of a comment', () => {
		const source = `// keep this file\n${fixture('strict-object', 'input.ts')}`
		expect(transformSource('a.ts', source).status).toBe('rewritten')
		const prefixed = `// cvx-kit-codemod: keep-zodiac\n${fixture('strict-object', 'input.ts')}`
		expect(transformSource('a.ts', prefixed).status).toBe('rewritten')
		const reasoned = `// cvx-kit-codemod: keep-zod -- SDK\n${fixture('strict-object', 'input.ts')}`
		expect(transformSource('a.ts', reasoned).status).toBe('kept')
	})
})

describe('codemod-v2 migration trial regressions', () => {
	it('ignores shadowed Zod bindings while rewriting type-only helpers', () => {
		const source = `import type { z } from 'zod'
import { k } from 'cvx-kit'
const Schema = k.string()
type Out = z.output<typeof Schema>
async function test() { const z = await cashier.mutation(); return [z.totals, z.variance, z._id] }
function parameter(z) { return z.totals }
try {} catch (z) { consume(z.totals) }
for (const z of rows) { consume(z.totals) }
`
		const outcome = transformSource('shadow.ts', source)
		expect(outcome.skipped).toEqual([])
		expect(outcome.output).toContain('type Out = k.output<typeof Schema>')
		expect(outcome.output).toContain('return [z.totals, z.variance, z._id]')
	})

	it('accepts field references on every kit table form', () => {
		const source = `import { kTable, kVariantTable, tenantTable } from 'cvx-kit/table'
import { z } from 'zod'
const a = kTable('a', fields)
const b = kVariantTable('b', schemas.fields)
const c = tenantTable('c', fields, opts)
const Held = z.tuple([])
`
		const outcome = transformSource('tables.ts', source)
		expect(outcome.skipped.map(({ code }) => code)).toEqual(['tuple'])
		expect(outcome.output).toBe(source)
		expect(outcome.declarations.rewritten).toBe(0)
	})

	it('removes obsolete zid imports and reports every held reference', () => {
		const source = `import { z } from 'zod'
import { zid, zodTable } from 'cvx-kit/zod-table'
const Held = z.tuple([zid('a'), zid('b')])
const Good = zodTable('good', () => ({ id: zid('a') }))
`
		const outcome = transformSource('ids.ts', source)
		expect(outcome.output).not.toContain('cvx-kit/zod-table')
		expect(outcome.output).toContain("import { kTable } from 'cvx-kit/table'")
		expect(outcome.output).toContain("const Held = z.tuple([zid('a'), zid('b')])")
		expect(
			outcome.skipped.filter(({ code }) => code === 'zid-in-zod-statement').map(({ line }) => line),
		).toEqual([3, 3])
		expect(transformSource('ids.ts', outcome.output).status).not.toBe('error')
		expect(transformSource('ids.ts', outcome.output).output).toBe(outcome.output)
	})

	it('recognizes derived k schemas and table schemas across files', () => {
		withTempTree({}, (root) => {
			writeFileSync(
				join(root, 'src/base.ts'),
				`import { k } from 'cvx-kit'
import { kTable } from 'cvx-kit/table'
export const recentItem = k.object({ a: k.string() })
export const table = kTable('items', { a: k.string() })
export const localDerived = recentItem.extend({}).partial().required()
`,
			)
			writeFileSync(
				join(root, 'src/types.ts'),
				`import type { z } from 'zod'
import { recentItem, table, localDerived } from './base'
const Derived = recentItem.extend({}).pick('a').omit('a').partial().required().optional().nullable().strict().strip()
type Out = z.output<typeof Derived>
type Local = z.infer<typeof localDerived>
${['insertSchema', 'updateSchema', 'commandInput', 'publicDto', 'schema', 'doc'].map((member) => `const ${member} = table.${member}\ntype T_${member} = z.input<typeof ${member}>`).join('\n')}
`,
			)
			const { report } = run(['src/base.ts', 'src/types.ts', '--write'], root)
			expect(report.totals).toEqual({})
			expect(readFileSync(join(root, 'src/types.ts'), 'utf8')).not.toContain('z.input')
			expect(readFileSync(join(root, 'src/types.ts'), 'utf8')).toContain('k.output<typeof Derived>')
			expect(readFileSync(join(root, 'src/types.ts'), 'utf8')).toContain(
				'k.infer<typeof localDerived>',
			)
		})
	})

	it('respects nearest package manifests and supports an explicit override', () => {
		withTempTree({}, (root) => {
			writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cvx-kit' }))
			for (const [name, manifest] of Object.entries({
				ui: {},
				app: { dependencies: { 'cvx-kit': '*' } },
				dev: { devDependencies: { 'cvx-kit': '*' } },
				peer: { peerDependencies: { 'cvx-kit': '*' } },
				optional: { optionalDependencies: { 'cvx-kit': '*' } },
			})) {
				mkdirSync(join(root, name, 'nested'), { recursive: true })
				writeFileSync(join(root, name, 'package.json'), JSON.stringify(manifest))
				writeFileSync(join(root, name, 'nested/schema.ts'), fixture('strict-object', 'input.ts'))
			}
			const { report, summary } = run(['ui', 'app', 'dev', 'peer', 'optional', '--write'], root)
			expect(report.packagesWithoutKit).toEqual(['ui'])
			expect(report.info['package-without-cvx-kit']).toBe(1)
			expect(report.summary.untouched).toBe(1)
			expect(report.summary.rewritten).toBe(4)
			expect(summary).toContain('packages without cvx-kit: 1\n  ui')
			expect(readFileSync(join(root, 'ui/nested/schema.ts'), 'utf8')).toBe(
				fixture('strict-object', 'input.ts'),
			)
			expect(run(['ui', '--include-packages-without-kit'], root).report.summary.rewritten).toBe(1)
			expect(HELP).toContain('--include-packages-without-kit')
		})
	})

	it('respects package manifests above the working directory', () => {
		withTempTree({}, (root) => {
			writeFileSync(join(root, 'package.json'), '{}')
			writeFileSync(join(root, 'src/schema.ts'), fixture('strict-object', 'input.ts'))
			const { report } = run(['schema.ts'], join(root, 'src'))
			expect(report.summary.rewritten).toBe(0)
			expect(report.packagesWithoutKit).toEqual(['..'])
		})
	})
})

describe('codemod-v2 object policies', () => {
	it('keeps explicit strip and strict calls and reports only table spreads', () => {
		const outcome = transformSource('p.ts', fixture('parsed-objects', 'input.ts'))
		expect(outcome.info.map(({ line, code }) => ({ line, code }))).toEqual([
			{ line: 12, code: 'table-spread' },
		])
		expect(outcome.output.match(/\.strip\(\)/g)).toHaveLength(1)
		expect(outcome.output).toContain('const Exact = k.strictObject({ id: k.string() })')
	})

	it('accepts --no-strip-parsed as a deprecated no-op and warns once', () => {
		withTempTree({ [join(FIXTURES, 'parsed-objects/input.ts')]: 'src/p.ts' }, (root) => {
			const printed = spawnSync(
				'node',
				[join(process.cwd(), CLI), 'src/p.ts', '--write', '--no-strip-parsed', '--no-strip-parsed'],
				{ cwd: root, encoding: 'utf8' },
			)
			expect(printed.status).toBe(0)
			expect(printed.stderr.trim().split('\n')).toEqual([
				'--no-strip-parsed is deprecated and no longer does anything.',
			])
			expect(readFileSync(join(root, 'src/p.ts'), 'utf8')).toBe(
				fixture('parsed-objects', 'expected.ts'),
			)
			expect(HELP).not.toContain('--no-strip-parsed')
		})
	})

	it('leaves beta.2 k strip and safe calls unchanged even in a mixed file', () => {
		const source =
			"import { k } from 'cvx-kit'\nimport { z } from 'zod'\nconst Old = k.object({ count: k.int().safe() }).strip(); const Count = k.number().int().safe(); const Derived = Old.partial().strip(); const New = z.string()\n"
		const output = transformSource('migrated.ts', source).output
		expect(output).toContain('k.object({ count: k.int().safe() }).strip()')
		expect(output).toContain('const Count = k.number().int().safe()')
		expect(output).toContain('const Derived = Old.partial().strip()')
		expect(transformSource('migrated.ts', output).output).toBe(output)
	})
})

describe('codemod-v2 cross-file knowledge', () => {
	it.each([
		[
			'function-local schema',
			'export function build() { const S = z.string(); return os.input(S) }',
		],
		[
			'object property builder',
			'const builders = { procedure: os.$context() }; const S = z.string(); export const r = builders.procedure.input(S)',
		],
		[
			'destructured builder',
			'const { input } = os; const S = z.string(); export const r = input(S)',
		],
		[
			'class field builder',
			'class Builder { procedure = os; build() { const S = z.string(); return this.procedure.input(S) } }',
		],
		[
			'nested router schema',
			'const S = z.string(); export const r = os.router({ nested: { procedure: S } })',
		],
		[
			'spread-wrapped schema',
			'const S = z.string(); export const r = os.router({ ...{ procedure: S } })',
		],
	])('holds a %s consumed by a third-party builder', (_name, declaration) => {
		const source = `import { z } from 'zod'\nimport { os } from '@orpc/server'\n${declaration}\n`
		const result = transformSource('consumer.ts', source)
		expect(result.output).toContain('S = z.string()')
		expect(result.skipped.map((site) => site.code)).toContain('zod-consumer')
		expect(transformSource('consumer.ts', result.output).output).toBe(result.output)
	})

	it('holds and reports a schema when a member callee cannot be traced', () => {
		const source =
			"import { z } from 'zod'\nconst builders = unknownFactory(); const S = z.string(); builders.procedure.input(S)\n"
		const result = transformSource('consumer.ts', source)
		expect(result.output).toContain('S = z.string()')
		expect(result.skipped.map((site) => site.code)).toContain('zod-consumer-unproven')
	})

	it.each([
		['tuple', "const Values = ['x', 'y'] as const"],
		['frozen', "const Values = Object.freeze(['x', 'y'])"],
		['satisfies', "const Values = (['x', 'y'] satisfies readonly string[])"],
		['spread', "const A = ['x'] as const; const B = ['y']; const Values = [...A, ...B] as const"],
		['object', "const Values = { X: 'x', Y: 'y' }"],
		['const object', "const Values = { X: 'x', Y: 'y' } as const"],
		['string enum', "enum Values { X = 'x', Y = 'y' }"],
		[
			'local string enum',
			"function build() { enum Values { X = 'x', Y = 'y' }; return z.enum(Values) }",
		],
		[
			'local tuple',
			"function build() { const Values = ['x', 'y'] as const; return z.enum(Values) }",
		],
	])('proves %s enum values and remains idempotent', (_name, declaration) => {
		const source = `import { z } from 'zod'; ${declaration}; ${_name.startsWith('local ') ? '' : 'export const S = z.enum(Values)'}`
		const result = transformSource('enum.ts', source)
		expect(result.skipped.filter((site) => site.code === 'enum-unproven')).toHaveLength(0)
		expect(result.output).toContain('k.enum(Values)')
		expect(transformSource('enum.ts', result.output).output).toBe(result.output)
	})

	it.each([
		'enum Values { X, Y }',
		"const Values = { X: 'x', Y: 1 }",
		"const Values = ['x', 1] as const",
		'const Values: string[] = [external]',
		"const Values = ['x'].map(x => x)",
		'const Values = makeValues()',
		"import { Values } from 'external-package'",
		"const Values = ['x']; function build(Values: any) { return z.enum(Values) }",
	])('keeps unproven enum values: %s', (declaration) => {
		const source = `import { z } from 'zod'; ${declaration}; ${declaration.includes('function build') ? '' : 'export const S = z.enum(Values)'}`
		const result = transformSource('enum.ts', source)
		expect(result.skipped.filter((site) => site.code === 'enum-unproven')).toHaveLength(1)
		expect(result.output).toBe(source)
	})

	it.each([
		"expect(z.string().parse(line)).toBe('a')",
		"Effect.gen(function* () { return S.parse(yield* Effect.succeed({ id: '1' })) })",
		'library(S.parse(line))',
		'library(S.safeParse(line))',
		'library(S.parseAsync(line))',
		'library(S.safeParseAsync(line))',
		'library(S.encode(line))',
		'library(S.decode(line))',
		'library(S.safeEncodeAsync(line))',
		'library(S.safeDecodeAsync(line))',
		'library(S.is(line))',
		'library(S._zod)',
		'const value = S._zod; library(value)',
		"library(S['~standard'].validate(line))",
		'library(() => S.parse(line))',
		'library(class { method() { return S.parse(line) } })',
		'expect(S).toBeDefined(); assert(S); console.log(S); vi.fn(S); jest.fn(S)',
	])('rewrites schemas used only in values or callbacks: %s', (use) => {
		const source = `import { z } from 'zod'; import { Effect } from 'effect'; import { library } from 'external'; const S = z.object({ id: z.string() }); ${use}`
		const result = transformSource('consumer.ts', source)
		expect(result.skipped.filter((site) => site.code.startsWith('zod-consumer'))).toEqual([])
		if (/S\.(?:encode|decode|safeEncodeAsync|safeDecodeAsync|is)\(/.test(use))
			expect(result.skipped.map((site) => site.code)).toContain('unknown-method')
		else expect(result.output).toContain('S = k.object(')
		expect(transformSource('consumer.ts', result.output).output).toBe(result.output)
	})

	it('does not prove a barrel star over an explicit non-string export', () => {
		tree(
			{
				'good.ts': "export const Values = ['x'] as const",
				'barrel.ts': "export * from './good'; export const Values = [1]",
				'use.ts':
					"import { z } from 'zod'; import { Values } from './barrel'; const S = z.enum(Values)",
			},
			(root) => {
				const result = run(['.', '--write'], root)
				expect(result.report.totals['enum-unproven']).toBe(1)
			},
		)
	})

	it('reports a callback returning a schema without holding it', () => {
		const result = transformSource(
			'callback.ts',
			"import { z } from 'zod'; import { library } from 'external'; const S = z.string(); library(() => S)",
		)
		expect(result.output).toContain('S = k.string()')
		expect(result.skipped.filter((site) => site.code === 'zod-consumer-unproven')).toHaveLength(1)
	})

	it.each([
		'S.optional()',
		'z.array(S)',
		'z.object({ ...S.shape })',
		'S.shape.id',
		'({ input: S } as const)',
		'[S]',
	])('holds a schema value wrapper %s', (argument) => {
		const result = transformSource(
			'consumer.ts',
			`import { z } from 'zod'; import { library } from 'external'; const S = z.object({ id: z.string() }); library(${argument})`,
		)
		expect(result.output).toContain('S = z.object(')
		expect(result.skipped.filter((site) => site.code === 'zod-consumer')).toHaveLength(1)
	})

	it('holds the outer dependencies of a function-local consumed schema', () => {
		const source =
			"import { z } from 'zod'; import { os } from '@orpc/server'; const Base = z.string(); export function build() { const S = z.object({ base: Base }); return os.input(S) }"
		const result = transformSource('consumer.ts', source)
		expect(result.output).toContain('Base = z.string()')
		expect(result.output).toContain('S = z.object({ base: Base })')
	})

	it.each([
		"import { k } from 'cvx-kit'; export const S = k.object({ returns: z.void() })",
		"import { kContract } from 'cvx-kit/contracts'; export const S = kContract.other({ returns: z.void() })",
		"import { kContract } from 'cvx-kit/contracts'; const factory = kContract; export const S = factory.other({ returns: z.void() })",
	])('rejects a returns field outside a function definition or contract: %s', (declaration) => {
		const result = transformSource('schema.ts', `import { z } from 'zod'; ${declaration}`)
		expect(result.output).toContain('returns: z.void()')
		expect(result.skipped.map((site) => site.code)).toContain('void-position')
	})

	it.each([
		"import { query } from './_generated/server'; export const S = query({ returns: z.void(), handler: () => {} })",
		"import { kCustomQuery } from 'cvx-kit/registration'; const query = kCustomQuery(base, options); export const S = query({ returns: z.void(), handler: () => {} })",
		"import { kContract } from 'cvx-kit/contracts'; export const S = kContract({ returns: z.void() })",
		"import { queryGeneric as query } from 'convex/server'; export function build(query: any) { return query({ returns: z.void(), handler: () => {} }) }",
		"import { authQuery } from './auth'; export const S = authQuery({ returns: z.void(), handler: () => {} })",
	])('migrates void in a function definition or resolved contract: %s', (declaration) => {
		const result = transformSource('schema.ts', `import { z } from 'zod'; ${declaration}`)
		expect(result.output).toContain('k.void()')
		expect(result.skipped.map((site) => site.code)).not.toContain('void-position')
	})

	it('follows an instance builder field to its third-party initializer', () => {
		const source =
			"import { z } from 'zod'; import { os } from '@orpc/server'; class Builder { procedure = os }; const builder = new Builder(); const S = z.string(); builder.procedure.input(S)"
		const result = transformSource('consumer.ts', source)
		expect(result.output).toContain('S = z.string()')
		expect(result.skipped.map((site) => site.code)).toContain('zod-consumer')
	})

	it('does not convert a bridge argument that resolves to a parameter', () => {
		const source =
			"import { z } from 'zod'\nimport { zodToConvex } from 'convex-helpers/server/zod4'\nconst S = z.string(); export function bridge(S: any) { return zodToConvex(S) }\n"
		const result = transformSource('bridge.ts', source)
		expect(result.output).toContain('return zodToConvex(S)')
		expect(result.output).toContain('import { zodToConvex }')
		expect(result.skipped.map((site) => site.code)).toContain('zod-to-convex-unknown')
	})

	it('resolves a function-scoped var before an outer schema', () => {
		const source =
			"import { z } from 'zod'; import { zodToConvex } from 'convex-helpers/server/zod4'; const S = z.string(); export function bridge() { if (ready) { var S = other }; return zodToConvex(S) }"
		const result = transformSource('bridge.ts', source)
		expect(result.output).toContain('return zodToConvex(S)')
		expect(result.skipped.map((site) => site.code)).toContain('zod-to-convex-unknown')
	})

	it('reports an untraceable builder member on a parameter', () => {
		const source =
			"import { z } from 'zod'; const S = z.string(); export function build(builder: any) { return builder.input(S) }"
		const result = transformSource('consumer.ts', source)
		expect(result.output).toContain('S = z.string()')
		expect(result.skipped.map((site) => site.code)).toContain('zod-consumer-unproven')
	})

	it('holds void in an ordinary object field named returns', () => {
		const result = transformSource(
			'schema.ts',
			"import { z } from 'zod'\nexport const S = z.object({ returns: z.void() })\n",
		)
		expect(result.output).toContain('returns: z.void()')
		expect(result.skipped.map((site) => site.code)).toContain('void-position')
	})

	it('lets a nearer callable parameter override an outer builder', () => {
		const result = transformSource(
			'consumer.ts',
			"import { z } from 'zod'\nimport { os } from '@orpc/server'\nconst procedure = os; const S = z.string(); export function build(procedure: (s: unknown) => unknown) { return procedure(S) }\n",
		)
		expect(result.output).toContain('S = k.string()')
		expect(result.skipped.map((site) => site.code)).not.toContain('zod-consumer')
	})

	it.each([
		[
			'default',
			"import { os } from '@orpc/server'; export default os",
			"import os from './builder'; os.input(S)",
		],
		[
			'namespace',
			"import { os } from '@orpc/server'; export { os }",
			"import * as builder from './builder'; builder.os.input(S)",
		],
	])('follows a %s builder export', (_name, builder, use) => {
		tree(
			{ 'builder.ts': builder, 'main.ts': `import { z } from 'zod'; const S = z.string(); ${use}` },
			(root) => {
				const result = run(['.', '--write'], root)
				expect(readFileSync(join(root, 'main.ts'), 'utf8')).toContain('S = z.string()')
				expect(result.report.totals['zod-consumer']).toBe(1)
			},
		)
	})

	it.each([true, false])('checks held pipe bindings with keep marker %s', (marker) => {
		const source = marker
			? "// cvx-kit-codemod: keep-zod\nimport { z } from 'zod'; import { S } from './schema'; export const Kept = z.string().pipe(S)"
			: "import { z } from 'zod'; import { S } from './schema'; export function make(S: z.ZodString) { return z.string().startsWith('a').pipe(S) }"
		tree(
			{ 'schema.ts': "import { z } from 'zod'; export const S = z.string()", 'main.ts': source },
			(root) => {
				const result = run(['.', '--write'], root)
				expect(result.exitCode).toBe(marker ? 1 : 0)
				expect(result.report.totals['held-pipe-to-k'] ?? 0).toBe(marker ? 1 : 0)
				expect(readFileSync(join(root, 'main.ts'), 'utf8')).toBe(source)
			},
		)
	})

	function tree(files, body) {
		const root = mkdtempSync(join(tmpdir(), 'cvx-codemod-run-'))
		try {
			for (const [path, source] of Object.entries(files)) {
				mkdirSync(join(root, path, '..'), { recursive: true })
				writeFileSync(join(root, path), source)
			}
			return body(root)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	}

	it.each(['() => ({ BODY })', '() => { return { BODY } }'])(
		'follows thunk contracts, object aliases and destructuring: %s',
		(thunk) => {
			tree(
				{
					'leaf.ts':
						"import { z } from 'zod'\nexport const dto = z.object({ tenant: z.string() })\n",
					'contract.ts':
						"import { z } from 'zod'\nimport { dto } from './leaf'\nimport { defineDomainContract } from 'cvx-kit/contracts'\nexport const contract = defineDomainContract(" +
						thunk.replace(
							'BODY',
							'commands: { ready: { input: dto, result: z.void() } }, queries: { get: { input: dto, result: dto } }',
						) +
						')\n',
					'client.ts': "import { contract } from './contract'\nexport const alias = contract\n",
					'barrel.ts': "export { alias as forwarded } from './client'\n",
					'ready.ts':
						"import { forwarded } from './barrel'\nexport const ready = forwarded.commands.ready.input.extend({})\n",
					'use.ts':
						"import { z } from 'zod'\nimport { forwarded } from './barrel'\nimport { ready } from './ready'\nimport { zodToConvex } from 'convex-helpers/server/zod4'\nconst { commands: ops, queries } = forwarded\nconst mask = { tenant: true } as const\nconst input = ops.ready.input.omit(mask)\ntype A = z.infer<typeof ops.ready.input>\ntype B = z.output<typeof forwarded.commands.ready.result>\ntype C = z.input<typeof ready>\nconst validator = zodToConvex(ready)\nconst result = zodToConvex(forwarded.commands.ready.result)\nconst fields = queries.get.input.shape\n",
				},
				(root) => {
					const first = run(['.', '--write'], root)
					const output = readFileSync(join(root, 'use.ts'), 'utf8')
					expect(output).toContain("ops.ready.input.omit('tenant')")
					expect(output).toContain('k.infer<typeof ops.ready.input>')
					expect(output).toContain('k.output<typeof forwarded.commands.ready.result>')
					expect(output).toContain('k.input<typeof ready>')
					expect(output).toContain('validator = ready.validator')
					expect(output).toContain('result = forwarded.commands.ready.result.validator')
					expect(output).toContain('fields = queries.get.input.shape')
					expect(readFileSync(join(root, 'contract.ts'), 'utf8')).toContain('result: k.void()')
					expect(first.report.totals).toEqual({})
					expect(run(['.', '--write'], root).report.summary.rewritten).toBe(0)
				},
			)
		},
	)

	it('reports each bridge once when another bridge in its held statement was convertible', () => {
		const out = transformSource(
			'held.ts',
			"import { z } from 'zod'\nimport { zodToConvex } from 'convex-helpers/server/zod4'\nconst fn = configure({ args: zodToConvex(z.object({})), returns: zodToConvex(external), handler: (value: z.output<typeof external>) => value })\n",
		)
		expect(out.skipped.filter((site) => site.code === 'zod-to-convex-unknown')).toHaveLength(2)
	})

	it('keeps held and external thunk leaves unproven while following table DTO results', () => {
		tree(
			{
				'tables.ts':
					"import { z } from 'zod'\nimport { zodTable } from 'cvx-kit/zod-table'\nexport const table = zodTable('items', () => ({ tenant: z.string() }))\nexport const held = z.string().brand<'Held'>()\n",
				'contract.ts':
					"import { defineDomainContract } from 'cvx-kit/contracts'\nimport { table, held } from './tables'\nimport { external } from 'outside'\nexport const contract = defineDomainContract(() => ({ commands: { good: { input: table.insertSchema, result: table.dto(true) }, bad: { input: held, result: external } } }))\n",
				'use.ts':
					"import { z } from 'zod'\nimport { zodToConvex } from 'convex-helpers/server/zod4'\nimport { contract } from './contract'\nconst { result: dto } = contract.commands.good\nexport { dto }\ntype Good = z.output<typeof dto>\nconst good = zodToConvex(contract.commands.good.result)\ntype Bad = z.output<typeof contract.commands.bad.input>\nconst bad = zodToConvex(contract.commands.bad.result)\nconst mask = { tenant: true } as const\nconst held = contract.commands.bad.input.omit(mask)\n",
			},
			(root) => {
				const first = run(['.', '--write'], root)
				const output = readFileSync(join(root, 'use.ts'), 'utf8')
				expect(output).toContain('k.output<typeof dto>')
				expect(output).toContain('good = contract.commands.good.result.validator')
				expect(output).toContain('z.output<typeof contract.commands.bad.input>')
				expect(output).toContain('zodToConvex(contract.commands.bad.result)')
				expect(output).toContain('contract.commands.bad.input.omit(mask)')
				expect(first.report.totals['type-helper-unknown']).toBe(1)
				expect(first.report.totals['zod-to-convex-unknown']).toBe(1)
				expect(first.report.totals['unproven-mask']).toBe(1)
				expect(run(['.', '--write'], root).report.summary.rewritten).toBe(0)
			},
		)
	})

	it('rewrites imported constant masks and schema member paths across a run', () => {
		tree(
			{
				'masks.ts':
					'export const tenantScoped = ({ tenant: true } as const) satisfies Record<string, true>\n',
				'schemas.ts':
					"import { z } from 'zod'\nimport { defineDomainContract } from 'cvx-kit/contracts'\nexport const inboundArtifactInput = z.object({ tenant: z.string() })\nexport const contract = defineDomainContract({ commands: { ready: { input: z.object({ tenant: z.string() }), result: z.string() } } })\n",
				'use.ts':
					"import { z } from 'zod'\nimport * as inboundValidators from './schemas'\nimport { contract } from './schemas'\nimport { tenantScoped } from './masks'\nimport { zodToConvex } from 'convex-helpers/server/zod4'\nexport const inboundArtifactInput = inboundValidators.inboundArtifactInput\nconst ready = contract.commands.ready.input.extend({ extra: z.string() })\nconst masked = ready.omit(tenantScoped)\ntype A = z.infer<typeof inboundArtifactInput>\ntype B = z.input<typeof contract.commands.ready.input>\ntype C = z.output<typeof ready>\nconst a = zodToConvex(ready)\nconst b = zodToConvex(contract.commands.ready.result)\n",
			},
			(root) => {
				const first = run(['.', '--write'], root)
				const output = readFileSync(join(root, 'use.ts'), 'utf8')
				expect(output).toContain("ready.omit('tenant')")
				expect(output).toContain('k.infer<typeof inboundArtifactInput>')
				expect(output).toContain('k.input<typeof contract.commands.ready.input>')
				expect(output).toContain('k.output<typeof ready>')
				expect(output).toContain('a = ready.validator')
				expect(output).toContain('b = contract.commands.ready.result.validator')
				expect(first.report.totals).toEqual({})
				expect(run(['.', '--write'], root).report.summary.rewritten).toBe(0)
			},
		)
	})

	it('follows literal schema objects and re-exported member aliases while holding unknown paths', () => {
		tree(
			{
				'schemas.ts':
					"import { z } from 'zod'\nconst good = z.string()\nconst held = z.string().brand<'Held'>()\nexport const validators = { held }\nexport const clean = { nested: { good } }\n",
				'alias.ts': "import { clean } from './schemas'\nexport const alias = clean.nested.good\n",
				'use.ts':
					"import { z } from 'zod'\nimport { validators, clean } from './schemas'\nimport { alias } from './alias'\nimport { zodToConvex } from 'convex-helpers/server/zod4'\ntype A = z.infer<typeof clean.nested.good>\ntype B = z.infer<typeof alias>\ntype Unknown = z.infer<typeof clean.missing>\ntype Held = z.infer<typeof validators.held>\nconst a = zodToConvex(clean.nested.good)\nconst unknown = zodToConvex(clean.missing)\n",
			},
			(root) => {
				const first = run(['.', '--write'], root)
				const output = readFileSync(join(root, 'use.ts'), 'utf8')
				expect(output).toContain('k.infer<typeof clean.nested.good>')
				expect(output).toContain('k.infer<typeof alias>')
				expect(output).toContain('a = clean.nested.good.validator')
				expect(output).toContain('z.infer<typeof validators.held>')
				expect(output).toContain('z.infer<typeof clean.missing>')
				expect(output).toContain('zodToConvex(clean.missing)')
				expect(first.report.totals['type-helper-unknown']).toBeGreaterThanOrEqual(2)
				expect(run(['.', '--write'], root).report.summary.rewritten).toBe(0)
			},
		)
	})

	it('follows exported builder initializers and reports unresolved relative builders', () => {
		tree(
			{
				'builder.ts': "import { os } from '@orpc/server'\nexport const procedure = os.$context()\n",
				'use.ts':
					"import { z } from 'zod'\nimport { procedure } from './builder'\nconst A = z.string()\nprocedure.input(A)\n",
				'unknown.ts':
					"import { z } from 'zod'\nimport { procedure } from './missing'\nconst A = z.string()\nprocedure.input(A)\n",
			},
			(root) => {
				const outcome = run(['.', '--write'], root)
				expect(readFileSync(join(root, 'use.ts'), 'utf8')).toContain('z.string()')
				expect(outcome.report.totals['zod-consumer-unproven']).toBe(1)
			},
		)
	})

	it('resolves imported all-string enums and workspace helper consumers', () => {
		tree(
			{
				'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
				'packages/shared/package.json': JSON.stringify({
					name: '@app/shared',
					dependencies: { 'cvx-kit': '*' },
				}),
				'packages/shared/src/index.ts':
					"export const Status = { A: 'a', B: 'b' } as const; export function helper(value: any) { return value }",
				'packages/app/package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
				'packages/app/src/use.ts':
					"import { z } from 'zod'\nimport { Status, helper } from '@app/shared'\nconst A = z.enum(Status)\nhelper(A)\n",
			},
			(root) => {
				run(['packages', '--write'], root)
				expect(readFileSync(join(root, 'packages/app/src/use.ts'), 'utf8')).toContain(
					'k.enum(Status)',
				)
			},
		)
	})

	it('proves enum constants through relative, alias, workspace and barrel imports', () => {
		tree(
			{
				'package.json': JSON.stringify({
					workspaces: ['packages/*'],
					dependencies: { 'cvx-kit': '*' },
				}),
				'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@app/*': ['./*'] } } }),
				'constants.ts': "export const Values = ['x', 'y'] as const",
				'spread.ts':
					"import { Values } from './constants'; export const Repeated = [...Values, ...Values] as const",
				'barrel.ts': "export { Values as Statuses } from './constants'",
				'star.ts': "export * from './barrel'",
				'packages/shared/package.json': JSON.stringify({ name: '@shared/values' }),
				'packages/shared/src/index.ts': "export * from '../../../constants'",
				'use.ts':
					"import { z } from 'zod'; import { Values as A } from './constants'; import { Values as B } from '@app/constants'; import { Values as C } from '@shared/values'; import { Statuses as D } from './star'; import { Repeated as E } from './spread'; export const SA = z.enum(A); export const SB = z.enum(B); export const SC = z.enum(C); export const SD = z.enum(D); export const SE = z.enum(E)",
			},
			(root) => {
				const result = run(['.', '--write'], root)
				expect(result.report.totals['enum-unproven'] ?? 0).toBe(0)
				const output = readFileSync(join(root, 'use.ts'), 'utf8')
				for (const name of ['A', 'B', 'C', 'D', 'E']) expect(output).toContain(`k.enum(${name})`)
				expect(run(['.', '--write'], root).report.summary.rewritten).toBe(0)
				expect(readFileSync(join(root, 'use.ts'), 'utf8')).toBe(output)
			},
		)
	})

	it('reports paths relative to a symlinked project root', () => {
		tree(
			{
				'project/package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
				'project/src/enums.ts': "import { z } from 'zod'; export const S = z.enum(Unknown)",
			},
			(root) => {
				symlinkSync(join(root, 'project'), join(root, 'alias'))
				const result = run([join(root, 'alias/src')], join(root, 'project'))
				expect(result.report.files.map((file) => file.path)).toEqual(['src/enums.ts'])
			},
		)
	})

	it('reports cross-file Zod consumers and held pipes into rewritten schemas', () => {
		tree(
			{
				'schema.ts': "import { z } from 'zod'\nexport const Schema = z.string()\n",
				'use.ts':
					"import { Schema } from './schema'\nimport { os } from '@orpc/server'\nos.input(Schema)\n",
				'held.ts':
					"import { z } from 'zod'\nimport { Schema } from './schema'\nconst A = z.string().brand<'A'>().pipe(Schema)\n",
			},
			(root) => {
				const outcome = run(['.', '--write'], root)
				expect(outcome.report.totals['zod-consumer-import']).toBe(1)
				expect(outcome.report.totals['held-pipe-to-k']).toBe(1)
				expect(outcome.exitCode).toBe(1)
				expect(readFileSync(join(root, 'schema.ts'), 'utf8')).toContain('k.string()')
				expect(run(['.', '--write'], root).report.summary.rewritten).toBe(0)
			},
		)
	})

	it('rewrites app helper consumers but follows relative builder re-exports', () => {
		tree(
			{
				'tsconfig.json': '{ "compilerOptions": { "paths": { "@app/*": ["./*"] } } }',
				'helper.ts': 'export function helper(value: any) { return value }',
				'builder.ts': "export { os } from '@orpc/server'",
				'alias.ts':
					"import { z } from 'zod'\nimport { helper } from '@app/helper'\nconst A = z.string()\nhelper(A)\n",
				'relative.ts':
					"import { z } from 'zod'\nimport { helper } from './helper'\nconst A = z.string()\nhelper(A)\n",
				'reexport.ts':
					"import { z } from 'zod'\nimport { os } from './builder'\nconst A = z.string()\nos.input(A)\n",
			},
			(root) => {
				const outcome = run(['.', '--write'], root)
				expect(readFileSync(join(root, 'alias.ts'), 'utf8')).toContain('k.string()')
				expect(readFileSync(join(root, 'relative.ts'), 'utf8')).toContain('k.string()')
				expect(readFileSync(join(root, 'reexport.ts'), 'utf8')).toContain('z.string()')
				expect(outcome.report.totals['zod-consumer']).toBe(1)
			},
		)
	})

	it('finds the package boundary above a subdirectory working directory', () => {
		tree(
			{
				'packages/plain/package.json': '{}',
				'packages/plain/src/a.ts': "import { z } from 'zod'\nconst A = z.string()\n",
			},
			(root) => {
				const outcome = run(['.', '--write'], join(root, 'packages/plain/src'))
				expect(outcome.report.info['package-without-cvx-kit']).toBe(1)
				expect(readFileSync(join(root, 'packages/plain/src/a.ts'), 'utf8')).toContain('z.string()')
			},
		)
	})

	it('checks package imports outside the selected files before declaring it client-only', () => {
		tree(
			{
				'package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
				'server.ts': "import { kTable } from 'cvx-kit/table'\n",
				'client.ts':
					"import { useQuery } from 'cvx-kit/react'\nimport { z } from 'zod'\nconst A = z.string()\n",
			},
			(root) => {
				expect(run(['client.ts'], root).report.summary.rewritten).toBe(1)
			},
		)
	})

	it('excludes client-only kit packages unless explicitly included', () => {
		tree(
			{
				'package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
				'client.ts':
					"import { useQuery } from 'cvx-kit/react'\nimport { z } from 'zod'\nconst A = z.string()\n",
			},
			(root) => {
				expect(run(['.'], root).report.info['package-without-cvx-kit']).toBe(1)
				run(['.', '--include-packages-without-kit', '--write'], root)
				expect(readFileSync(join(root, 'client.ts'), 'utf8')).toContain('k.string()')
			},
		)
	})

	it('rewrites imported schema bridges and keeps report paths stable below the root', () => {
		tree(
			{
				'package.json': JSON.stringify({ dependencies: { 'cvx-kit': '*' } }),
				'src/schema.ts': "import { z } from 'zod'\nexport const Schema = z.string()\n",
				'src/use.ts':
					"import { Schema } from './schema'\nimport { zodToConvex } from 'convex-helpers/server/zod4'\nexport const A = zodToConvex(Schema)\n",
			},
			(root) => {
				const before = run(['src'], root)
				const below = run(['.'], join(root, 'src'))
				expect(below.report.files.map((file) => file.path)).toEqual(
					before.report.files.map((file) => file.path),
				)
				run(['src', '--write'], root)
				expect(readFileSync(join(root, 'src/use.ts'), 'utf8')).toContain('A = Schema.validator')
				expect(readFileSync(join(root, 'src/use.ts'), 'utf8')).not.toContain('zodToConvex')
				expect(run(['src'], root).report.summary.rewritten).toBe(0)
			},
		)
	})

	it('rewrites imported table masks and reports unreadable masks', () => {
		tree(
			{
				'tables.ts':
					"import { z } from 'zod'\nimport { tenantTable } from 'cvx-kit/zod-table'\nexport const users = tenantTable('users', (id) => ({ name: z.string() }))\n",
				'use.ts':
					"import { users } from './tables'\nconst A = users.commandInput.pick({ name: true })\nconst B = users.commandInput.omit(mask)\n",
			},
			(root) => {
				const first = run(['.', '--write'], root)
				expect(readFileSync(join(root, 'use.ts'), 'utf8')).toContain("pick('name')")
				expect(first.report.totals['mask-dynamic']).toBe(1)
				expect(run(['.', '--write'], root).report.summary.rewritten).toBe(0)
			},
		)
	})

	it.each([
		[
			'paths alias',
			{ 'tsconfig.json': '{ "compilerOptions": { "paths": { "@backend/*": ["./src/*"] } } }' },
			'@backend/tables',
		],
		[
			'inherited paths and baseUrl',
			{
				'config/base.json':
					'{ // inherited relative to this file\n "compilerOptions": { "baseUrl": "..", "paths": { "@backend/*": ["src/*"], }, }, }',
				'tsconfig.json': '{ "extends": "./config/base.json" }',
			},
			'@backend/tables',
		],
		[
			'first existing wildcard candidate',
			{
				'tsconfig.json': JSON.stringify({
					compilerOptions: { paths: { '@backend/*': ['./missing/*', './src/*', './other/*'] } },
				}),
				'other/tables.ts': 'export const table = {}',
			},
			'@backend/tables',
		],
		[
			'nearest tsconfig',
			{
				'tsconfig.json': '{ "compilerOptions": { "paths": { "@backend/*": ["./wrong/*"] } } }',
				'src/tsconfig.json': '{ "compilerOptions": { "paths": { "@backend/*": ["./*"] } } }',
			},
			'@backend/tables',
		],
	])('learns imported tables through %s', (_label, config, specifier) => {
		tree(
			{
				...config,
				'src/tables.ts':
					"import { k } from 'cvx-kit'\nimport { kTable } from 'cvx-kit/table'\nexport const table = kTable('items', { a: k.string() })\n",
				'src/types.ts': `import type { z } from 'zod'\nimport { table } from '${specifier}'\ntype Out = z.infer<typeof table.schema>\n`,
			},
			(root) => {
				const { report } = run(['src', '--write'], root)
				expect(readFileSync(join(root, 'src/types.ts'), 'utf8')).toContain(
					'k.infer<typeof table.schema>',
				)
				expect(report.totals).toEqual({})
			},
		)
	})

	it.each([
		['exports', { exports: { '.': { types: './src/index.ts', import: './dist/index.js' } } }],
		['main', { main: './src/index.js' }],
		['src entry', {}],
	])('learns schemas from a workspace package through its %s', (_label, entry) => {
		tree(
			{
				'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
				'packages/shared/package.json': JSON.stringify({ name: '@app/shared', ...entry }),
				'packages/shared/src/index.ts':
					"import { z } from 'zod'\nexport const Schema = z.string()\n",
				'packages/app/package.json': '{}',
				'packages/app/src/types.ts':
					"import type { z } from 'zod'\nimport { Schema } from '@app/shared'\ntype Out = z.infer<typeof Schema>\n",
			},
			(root) => {
				run(['packages', '--include-packages-without-kit', '--write'], root)
				expect(readFileSync(join(root, 'packages/app/src/types.ts'), 'utf8')).toContain(
					'k.infer<typeof Schema>',
				)
			},
		)
	})

	it('keeps an unmatched bare import unknown', () => {
		const source =
			"import type { z } from 'zod'\nimport { Schema } from '@external/shared'\ntype Out = z.infer<typeof Schema>\n"
		tree({ 'src/types.ts': source }, (root) => {
			const { report } = run(['src', '--write'], root)
			expect(readFileSync(join(root, 'src/types.ts'), 'utf8')).toBe(source)
			expect(report.totals['type-helper-unknown']).toBe(1)
		})
	})

	it('resolves app source independently of scanned facts using pnpm workspace subpaths', () => {
		tree(
			{
				'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
				'packages/shared/package.json': JSON.stringify({
					name: '@app/shared',
					exports: { './*': './src/*.ts' },
				}),
				'packages/shared/src/helper.ts': 'export const helper = (value) => value',
				'packages/app/src/consumer.ts': '',
			},
			(root) => {
				const resolveSource = createSourceResolver(root)
				expect(resolveSource('packages/app/src/consumer.ts', '@app/shared/helper')).toBe(
					'packages/shared/src/helper.ts',
				)
				expect(resolveSource('packages/app/src/consumer.ts', '@external/shared')).toBeNull()
			},
		)
	})

	it('rewrites a type helper on a schema imported from a file the run rewrites, and reports one that stays Zod', () => {
		tree(
			{
				'src/schemas.ts':
					"import { z } from 'zod'\nexport const Ok = z.object({ a: z.string() })\nexport const Loose = z.object({}).catchall(z.string())\n",
				'src/types.ts':
					"import { z } from 'zod'\nimport { Ok, Loose } from './schemas'\nexport type Ok = z.infer<typeof Ok>\nexport type Loose = z.infer<typeof Loose>\n",
			},
			(root) => {
				const { report } = run(['src', '--write'], root)
				expect(readFileSync(join(root, 'src/types.ts'), 'utf8')).toBe(
					"import { z } from 'zod'\nimport { Ok, Loose } from './schemas'\nimport { k } from 'cvx-kit'\nexport type Ok = k.infer<typeof Ok>\nexport type Loose = z.infer<typeof Loose>\n",
				)
				const types = report.files.find((file) => file.path.endsWith('types.ts'))
				expect(types.skipped.map(({ code }) => code)).toEqual(['type-helper-unknown'])
			},
		)
	})

	it('preserves plain objects whether imported for parsing or used as args', () => {
		tree(
			{
				'src/schemas.ts':
					"import { z } from 'zod'\nexport const Payload = z.object({ id: z.string() })\nexport const Args = z.object({ id: z.string() })\n",
				'src/webhook.ts':
					"import { Payload } from './schemas'\nexport const read = (body: unknown) => Payload.parse(body)\n",
				'src/functions.ts':
					"import { Args } from './schemas'\nexport const definition = { args: Args }\n",
			},
			(root) => {
				const { report } = run(['src', '--write'], root)
				expect(readFileSync(join(root, 'src/schemas.ts'), 'utf8')).toBe(
					"import { k } from 'cvx-kit'\nexport const Payload = k.object({ id: k.string() })\nexport const Args = k.object({ id: k.string() })\n",
				)
				expect(report.info).toEqual({})
			},
		)
	})

	it('exits 0 when every file parses', () => {
		withTempTree({ [join(FIXTURES, 'strict-object/input.ts')]: 'ok/strict.ts' }, (root) => {
			expect(run(['ok'], root).exitCode).toBe(0)
			const printed = spawnSync('node', [join(process.cwd(), CLI), 'ok'], { cwd: root })
			expect(printed.status).toBe(0)
		})
	})

	it('--help documents exit codes, globs and symlinks', () => {
		expect(HELP).toContain('Exit codes: 0 when every file parsed')
		expect(HELP).toContain('does not expand globs')
		expect(HELP).toContain('outsideRoots')
	})

	it('a quoted glob gets a clear message', () => {
		withTempTree({}, (root) => {
			expect(() => run(['src/**/*.ts'], root)).toThrow(/does not expand globs/)
			expect(() => run(['missing'], root)).toThrow(/Path not found: missing/)
		})
	})

	it('--write never follows a symlink outside the given paths', () => {
		withTempTree(
			{
				[join(FIXTURES, 'strict-object/input.ts')]: 'outside/target.ts',
				[join(FIXTURES, 'mixed-file/input.ts')]: 'src/inner/mixed.ts',
			},
			(root) => {
				const outsideBefore = readFileSync(join(root, 'outside/target.ts'), 'utf8')
				symlinkSync(join(root, 'outside/target.ts'), join(root, 'src/link.ts'))
				symlinkSync(join(root, 'outside'), join(root, 'src/linkdir'))
				symlinkSync(join(root, 'src/inner'), join(root, 'src/alias'))
				symlinkSync(join(root, 'src'), join(root, 'src/inner/loop'))
				const { report } = run(['src', '--write', '--ignore', 'src/broken.ts'], root)
				expect(readFileSync(join(root, 'outside/target.ts'), 'utf8')).toBe(outsideBefore)
				expect(report.outsideRoots.sort()).toEqual(['src/link.ts', 'src/linkdir'])
				expect(report.files.filter((file) => file.path.endsWith('mixed.ts'))).toHaveLength(1)
			},
		)
	})
})

describe('source resolver with a tsconfig that cannot be loaded', () => {
	it('still resolves relative imports when `extends` names a package that is not installed', () => {
		const root = mkdtempSync(join(tmpdir(), 'cvx-codemod-extends-'))
		try {
			mkdirSync(join(root, 'src'), { recursive: true })
			writeFileSync(
				join(root, 'tsconfig.json'),
				JSON.stringify({ extends: '@not-installed/tooling/base.json' }),
			)
			writeFileSync(join(root, 'src/constants.ts'), "export const A = ['x'] as const\n")
			writeFileSync(join(root, 'src/schema.ts'), "import { A } from './constants'\nexport { A }\n")
			expect(createSourceResolver(root)('src/schema.ts', './constants')).toBe('src/constants.ts')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})

describe('codemod-v2 app gap regressions', () => {
	function transformTemp(path, source) {
		const root = mkdtempSync(join(tmpdir(), 'cvx-codemod-gap-'))
		try {
			writeFileSync(join(root, path), source)
			const { report } = run([path, '--write'], root)
			return { ...report.files[0], output: readFileSync(join(root, path), 'utf8') }
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	}

	it('resolves lexical constant masks and leaves unsupported masks reported', () => {
		const source =
			"import { z } from 'zod'\nconst mask = ({ tenant: true } as const) satisfies Record<string, true>\nconst S = z.object({ tenant: z.string() })\nconst a = S.pick(mask); const b = S.omit(mask); const c = S.partial(mask); const d = S.required(mask)\nfunction scoped(mask: any) { return S.pick(mask) }\nconst bad = { tenant: false }; const e = S.omit(bad)\nconst spread = { ...mask }; const f = S.pick(spread)\nconst computed = { ['tenant']: true }; const g = S.pick(computed)\nlet mutable = { tenant: true }; const h = S.pick(mutable)\n"
		const out = transformTemp('masks.ts', source)
		for (const method of ['pick', 'omit', 'partial', 'required'])
			expect(out.output).toContain(`S.${method}('tenant')`)
		expect(out.output).toContain('const mask = ({ tenant: true } as const)')
		expect(out.skipped.map((site) => site.code)).toEqual(Array(5).fill('mask-dynamic'))
		expect(transformTemp('masks.ts', out.output).output).toBe(out.output)
	})

	it('rewrites void only in contract operation results', () => {
		const source =
			"import { z } from 'zod'\nimport { defineDomainContract as define } from 'cvx-kit/contracts'\nconst contract = define({ commands: { x: { input: z.object({}), result: z.void() } }, queries: { y: { input: z.string(), result: z.void() } } })\nregistry.command({ input: z.string(), result: z.void(), handler: () => {} })\nregistry.query({ input: z.string(), result: z.void(), handler: () => {} })\nconst bad = z.object({ result: z.void() })\nconst arr = z.array(z.void())\nconst union = z.union([z.string(), z.void()])\nregistry.command({ input: z.void(), result: z.string(), handler: () => {} })\n"
		const out = transformTemp('void.ts', source)
		expect(out.output.match(/result: k.void\(\)/g)).toHaveLength(4)
		expect(out.skipped.filter((site) => site.code === 'void-position')).toHaveLength(4)
		expect(transformTemp('void.ts', out.output).output).toBe(out.output)
	})

	it('rewrites call-produced enums with a runtime-check notice and holds numeric enums', () => {
		const source =
			"import { z } from 'zod'\nconst A = z.enum(list.map(item => item.slug))\nconst B = z.enum(list.filter(Boolean))\nconst C = z.enum(Object.keys(values))\nconst D = z.enum(Object.values(values))\nconst E = z.enum(load())\nenum Numeric { A, B }\nconst F = z.enum(Numeric)\nconst Mixed = { a: 'a', b: 1 } as const\nconst G = z.enum(Mixed)\n"
		const out = transformTemp('enums.ts', source)
		expect(out.info.map((site) => site.code)).toEqual(Array(5).fill('enum-runtime-checked'))
		expect(out.skipped.map((site) => site.code)).toEqual(['enum-unproven', 'enum-unproven'])
		expect(out.output).toContain('k.enum(list.map(item => item.slug))')
		expect(transformTemp('enums.ts', out.output).output).toBe(out.output)
	})

	it('rewrites inline bridges in an otherwise kept file and reports unsupported inline bridges', () => {
		const source =
			"import { z } from 'zod'\nimport { zodToConvex } from 'convex-helpers/server/zod4'\nconst held = z.string().brand<'Held'>()\nconst good = zodToConvex(z.object({ a: z.string() }))\nconst bad = zodToConvex(z.string().brand<'Bad'>())\n"
		const out = transformTemp('inline.ts', source)
		expect(out.output).toContain('(k.object({ a: k.string() })).validator')
		expect(out.skipped.map((site) => site.code)).toContain('zod-to-convex-unknown')
		expect(transformTemp('inline.ts', out.output).output).toBe(out.output)
	})

	it('does not treat JavaScript globals or a shape object as schema consumers', () => {
		const source =
			"import { z } from 'zod'\nimport { consume } from 'external'\nconst S = z.object({ a: z.string() })\nObject.keys(S.shape); Object.values(S.shape); Object.entries(S.shape); JSON.stringify(S); Array.from([S]); structuredClone(S); Reflect.ownKeys(S.shape); consume(S.shape)\n"
		const out = transformTemp('globals.ts', source)
		expect(out.skipped).toEqual([])
		expect(out.output).toContain('k.object')
	})

	it('moves an unused paginated import and reports unhandled v1 entry imports', () => {
		const moved = transformTemp('page.ts', "import { paginated } from 'cvx-kit/zod-table'\n")
		expect(moved.output).toBe("import { paginated } from 'cvx-kit/table'\n")
		const bridged = transformTemp(
			'bridge.ts',
			"import { z } from 'zod'\nimport { zodToConvex } from 'cvx-kit/zod-table'\nconst result = zodToConvex(z.string())\n",
		)
		expect(bridged.skipped).toEqual([])
		expect(bridged.output).not.toContain('cvx-kit/zod-table')
		for (const source of [
			"import * as tables from 'cvx-kit/zod-table'\n",
			"import 'cvx-kit/zod-table'\n",
			"import { jsonSafeZid } from 'cvx-kit/zod-table'\n",
		]) {
			const out = transformTemp('old.ts', source)
			expect(out.skipped.map((site) => site.code)).toContain('v1-entry-string')
		}
	})
})
