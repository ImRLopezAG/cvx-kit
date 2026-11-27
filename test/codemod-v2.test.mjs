// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process'
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
			code: 'loose-object',
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
		"import { authQuery } from './auth'",
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
			expect(report.totals).toEqual({ tuple: 1 })
			expect(report.declarations).toEqual({ rewritten: 4, left: 1 })
			expect(report.mechanicalShare).toBe(0.8)
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
			expect(second.declarations).toEqual({ rewritten: 0, left: 1 })
			const secondCli = spawnSync('node', [join(process.cwd(), CLI), 'src', '--ignore', 'src/broken.ts'], { cwd: root, encoding: 'utf8' })
			expect(secondCli.status).toBe(0)
			expect(secondCli.stdout).toContain('0 rewritten, 1 mixed')
			expect(secondCli.stdout).toContain('declarations: 0 rewritten, 1 left as Zod')
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
		expect(outcome.skipped.filter(({ code }) => code === 'zid-in-zod-statement').map(({ line }) => line)).toEqual([3, 3])
		expect(transformSource('ids.ts', outcome.output).status).not.toBe('error')
		expect(transformSource('ids.ts', outcome.output).output).toBe(outcome.output)
	})

	it('recognizes derived k schemas and table schemas across files', () => {
		withTempTree({}, (root) => {
			writeFileSync(join(root, 'src/base.ts'), `import { k } from 'cvx-kit'
import { kTable } from 'cvx-kit/table'
export const recentItem = k.object({ a: k.string() })
export const table = kTable('items', { a: k.string() })
export const localDerived = recentItem.extend({}).partial().required()
`)
			writeFileSync(join(root, 'src/types.ts'), `import type { z } from 'zod'
import { recentItem, table, localDerived } from './base'
const Derived = recentItem.extend({}).pick('a').omit('a').partial().required().optional().nullable().strict().strip()
type Out = z.output<typeof Derived>
type Local = z.infer<typeof localDerived>
${['insertSchema', 'updateSchema', 'commandInput', 'publicDto', 'schema', 'doc'].map((member) => `const ${member} = table.${member}\ntype T_${member} = z.input<typeof ${member}>`).join('\n')}
`)
			const { report } = run(['src/base.ts', 'src/types.ts', '--write'], root)
			expect(report.totals).toEqual({})
			expect(readFileSync(join(root, 'src/types.ts'), 'utf8')).not.toContain('z.input')
			expect(readFileSync(join(root, 'src/types.ts'), 'utf8')).toContain('k.output<typeof Derived>')
			expect(readFileSync(join(root, 'src/types.ts'), 'utf8')).toContain('k.infer<typeof localDerived>')
		})
	})

	it('respects nearest package manifests and supports an explicit override', () => {
		withTempTree({}, (root) => {
			writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cvx-kit' }))
			for (const [name, manifest] of Object.entries({ ui: {}, app: { dependencies: { 'cvx-kit': '*' } }, dev: { devDependencies: { 'cvx-kit': '*' } }, peer: { peerDependencies: { 'cvx-kit': '*' } }, optional: { optionalDependencies: { 'cvx-kit': '*' } } })) {
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
			expect(readFileSync(join(root, 'ui/nested/schema.ts'), 'utf8')).toBe(fixture('strict-object', 'input.ts'))
			expect(run(['ui', '--include-packages-without-kit'], root).report.summary.rewritten).toBe(1)
			expect(HELP).toContain('--include-packages-without-kit')
		})
	})

	it('does not search for package manifests above the working directory', () => {
		withTempTree({}, (root) => {
			writeFileSync(join(root, 'package.json'), '{}')
			writeFileSync(join(root, 'src/schema.ts'), fixture('strict-object', 'input.ts'))
			const { report } = run(['schema.ts'], join(root, 'src'))
			expect(report.summary.rewritten).toBe(1)
			expect(report.packagesWithoutKit).toEqual([])
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
