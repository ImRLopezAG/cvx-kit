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
import { run } from '../tools/codemod-v2/index.mjs'
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
			column: 22,
			code: 'loose-object',
			text: 'z.looseObject({ a: z.string() })',
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
		expect(outcome.info.map((site) => site.code)).toEqual(['object-now-strict'])
		expect(outcome.status).toBe('rewritten')
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

	it('reports the keep marker only on an exact comment', () => {
		const source = `// keep this file\n${fixture('strict-object', 'input.ts')}`
		expect(transformSource('a.ts', source).status).toBe('rewritten')
	})
})
