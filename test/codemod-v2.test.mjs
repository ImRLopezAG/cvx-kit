// @vitest-environment node
import { execFileSync } from 'node:child_process'
import {
	cpSync,
	existsSync,
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

	it('counts z.object sites as informational object-now-strict', () => {
		const outcome = transformSource('strict.ts', fixture('strict-object', 'input.ts'))
		expect(outcome.info.map((site) => site.code)).toEqual(['int-safe-preserved', 'object-now-strict'])
		expect(outcome.status).toBe('rewritten')
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
		'})',
		'',
	].join('\n')

	it("keeps v1's refusals by default and reports them as informational", () => {
		const outcome = transformSource('payment.ts', source)
		expect(outcome.output).toContain('\tcents: k.int().safe().positive(),')
		expect(outcome.output).toContain('\tunits: k.int().safe(),')
		expect(outcome.output).toContain('\tbefore: k.number().finite(),')
		expect(outcome.output).toContain('\tfloor: k.number().finite().min(0),')
		expect(outcome.output).toContain('\trate: k.number().finite(),')
		expect(outcome.output).toContain('\tsafe: k.int().safe(),')
		expect(outcome.info.map((site) => site.code).filter((code) => code !== 'object-now-strict'))
			.toEqual([
				'int-safe-preserved',
				'int-safe-preserved',
				'number-finite-preserved',
				'number-finite-preserved',
			])
		expect(outcome.status).toBe('rewritten')
		expect(transformSource('payment.ts', outcome.output).output).toBe(outcome.output)
	})

	it('emits the bare native forms with --native-number-bounds and reports each site', () => {
		const outcome = transformSource('payment.ts', source, { nativeNumberBounds: true })
		expect(outcome.output).toContain('\tcents: k.int().positive(),')
		expect(outcome.output).toContain('\tunits: k.number().int(),')
		expect(outcome.output).toContain('\tbefore: k.number(),')
		expect(outcome.output).toContain('\tfloor: k.number().min(0),')
		expect(outcome.info.map((site) => site.code).filter((code) => code !== 'object-now-strict'))
			.toEqual([
				'int-no-longer-safe',
				'int-no-longer-safe',
				'number-now-accepts-nan',
				'number-now-accepts-nan',
			])
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
		expect(output).toContain('\tget args() { return k.object({ id: k.string() }) },')
		expect(output).toContain('\treturns: shared.result,')
	})

	it('keeps data properties with getters: false', () => {
		const { output } = transformSource('fn.ts', source, { getters: false })
		expect(output).toContain('\targs: k.object({ id: k.string() }),')
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
			const printed = execFileSync(
				'node',
				[join(process.cwd(), CLI), 'src', '--report', reportFile],
				{
					cwd: root,
					encoding: 'utf8',
				},
			)
			expect(readFileSync(join(root, 'src/strict.ts'), 'utf8')).toBe(before)
			expect(printed).toContain('dry run')
			expect(printed).not.toContain('strict.ts')
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
			// No file of the run imports `Plain`, so its consumers are unknown and it keeps stripping.
			expect(readFileSync(join(root, 'src/strict.ts'), 'utf8')).toBe(
				fixture('strict-object', 'expected.ts').replace(
					'k.object({ c: k.boolean().nullable() })',
					'k.object({ c: k.boolean().nullable() }).strip()',
				),
			)
			expect(readFileSync(join(root, 'src/mixed.ts'), 'utf8')).toBe(
				fixture('mixed-file', 'expected.ts'),
			)
			expect(readFileSync(join(root, 'src/_generated/api.ts'), 'utf8')).toBe(
				fixture('factories', 'input.ts'),
			)
			const second = run(['src', '--write', '--ignore', 'src/broken.ts'], root).report
			expect(second.summary.rewritten).toBe(0)
			expect(second.files.find((file) => file.path.endsWith('mixed.ts')).status).toBe('untouched')
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

describe('codemod-v2 object classification', () => {
	const info = (outcome) => outcome.info.map(({ line, code }) => ({ line, code }))

	it('reports parsed objects, boundary-only objects and table spreads', () => {
		const outcome = transformSource('p.ts', fixture('parsed-objects', 'input.ts'))
		expect(info(outcome)).toEqual([
			{ line: 4, code: 'object-parsed-stripped' },
			{ line: 5, code: 'object-parsed-stripped' },
			{ line: 6, code: 'object-parsed-stripped' },
			{ line: 7, code: 'object-now-strict' },
			{ line: 12, code: 'table-spread' },
		])
	})

	it('--no-strip-parsed leaves parsed objects strict and reports them', () => {
		const outcome = transformSource('p.ts', fixture('parsed-objects', 'input.ts'), {
			stripParsed: false,
		})
		expect(outcome.output).not.toContain('}).strip()\nconst Customer')
		expect(outcome.output).toContain('const Declared = k.object({ id: k.string() }).strip()')
		expect(outcome.output.match(/\.strip\(\)/g)).toHaveLength(1)
		expect(info(outcome).filter(({ code }) => code === 'object-parsed-now-strict')).toHaveLength(3)
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

	it('strips an exported object that another file of the run parses, not one only used as args', () => {
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
					"import { k } from 'cvx-kit'\nexport const Payload = k.object({ id: k.string() }).strip()\nexport const Args = k.object({ id: k.string() })\n",
				)
				expect(report.info).toEqual({ 'object-now-strict': 1, 'object-parsed-stripped': 1 })
			},
		)
	})
})
