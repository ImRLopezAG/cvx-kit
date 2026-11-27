// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { parseArguments, run } from '../tools/codemod-v2/index.mjs'
import { restoreStrictSource } from '../tools/codemod-v2/restore-strict.mjs'

const BASE = `import { z } from 'zod'

export const Plain = z.object({ a: z.string() })
export const Strict = z.strictObject({ id: z.string(), nested: z.object({ n: z.number() }).strict() })
export const Loose = z.looseObject({ raw: z.string() })
export const Chained = z.object({ c: z.string() }).describe('c').strict()
export const Derived = Plain.strict()
export const Undone = z.strictObject({ u: z.string() }).strip()
`

// What the beta.2 codemod left: every factory is k.object, `.strict()` is gone.
const MIGRATED = `import { k } from 'cvx-kit'

export const Plain = k.object({ a: k.string() })
export const Strict = k.object({ id: k.string(), nested: k.object({ n: k.number().finite() }) })
export const Loose = k.looseObject({ raw: k.string() })
export const Chained = k.object({ c: k.string() }).describe('c')
export const Derived = Plain
export const Undone = k.object({ u: k.string() }).strip()
`

const RESTORED = `import { k } from 'cvx-kit'

export const Plain = k.object({ a: k.string() })
export const Strict = k.strictObject({ id: k.string(), nested: k.strictObject({ n: k.number().finite() }) })
export const Loose = k.looseObject({ raw: k.string() })
export const Chained = k.strictObject({ c: k.string() }).describe('c')
export const Derived = Plain
export const Undone = k.object({ u: k.string() }).strip()
`

describe('restoreStrictSource', () => {
	it('restores k.strictObject where the base Zod object was strict, and nothing else', () => {
		const outcome = restoreStrictSource('a.ts', MIGRATED, BASE)
		expect(outcome.output).toBe(RESTORED)
		expect(outcome.restored).toBe(3)
		expect(outcome.manual.map((site) => [site.code, site.baseLine])).toEqual([
			['strict-on-reference', 7],
		])
	})

	it('changes nothing on a second run and counts what is already strict', () => {
		const outcome = restoreStrictSource('a.ts', RESTORED, BASE)
		expect(outcome.output).toBe(RESTORED)
		expect([outcome.restored, outcome.already]).toEqual([0, 3])
	})

	it('pairs by field names when objects were added, removed or reordered since the base', () => {
		const current = `import { k } from 'cvx-kit'
export const Added = k.object({ brand: k.string(), fresh: k.string() })
export const Strict = k.object({ id: k.string(), nested: k.object({ n: k.number() }) })
export const Plain = k.object({ a: k.string() })
`
		const outcome = restoreStrictSource('a.ts', current, BASE)
		expect(outcome.output).toContain('Added = k.object({ brand')
		expect(outcome.output).toContain(
			'Strict = k.strictObject({ id: k.string(), nested: k.strictObject(',
		)
		expect(outcome.output).toContain('Plain = k.object(')
		expect(outcome.manual.map((site) => site.code).sort()).toEqual([
			'strict-on-reference',
			'strict-unpaired',
		])
	})

	it('reports a strict object whose fields changed, and one that now declares another policy', () => {
		const renamed = MIGRATED.replace('{ c: k.string() }', '{ renamed: k.string() }')
		expect(
			restoreStrictSource('a.ts', renamed, BASE).manual.map((site) => [site.code, site.baseLine]),
		).toContainEqual(['strict-unpaired', 6])
		const base = "import { z } from 'zod'\nexport const A = z.strictObject({ a: z.string() })\n"
		const current =
			"import { k } from 'cvx-kit'\nexport const A = k.object({ a: k.string() }).strip()\n"
		const outcome = restoreStrictSource('a.ts', current, base)
		expect(outcome.output).toBe(current)
		expect(outcome.manual.map((site) => site.code)).toEqual(['strict-now-other-policy'])
	})

	it('leaves objects still written in Zod, non-schema objects and files new since the base', () => {
		const base =
			"import { z } from 'zod'\nexport const A = z.strictObject({ a: z.string() })\nconst o = Object.freeze({ a: 1 })\n"
		const mixed =
			"import { z } from 'zod'\nexport const A = z.strictObject({ a: z.string() })\nconst o = Object.freeze({ a: 1 })\n"
		expect(restoreStrictSource('a.ts', mixed, base).output).toBe(mixed)
		expect(restoreStrictSource('a.ts', MIGRATED, null)).toMatchObject({
			output: MIGRATED,
			restored: 0,
		})
	})

	it('pairs an object that moved within the file, and accepts a strict counterpart whose fields moved', () => {
		const base = `import { z } from 'zod'
export const A = z.strictObject({ a: z.string() })
export const B = z.object({ b: z.string() })
export const C = z.strictObject({ c: z.string() })
export const D = z.strictObject({ d: z.string(), e: z.string() })
`
		// A moved below C and into an array; D's fields moved to a constant and it is already strict.
		const current = `import { k } from 'cvx-kit'
const fields = { d: k.string(), e: k.string() }
export const B = k.object({ b: k.string() })
export const C = k.object({ c: k.string() })
export const A = k.array(k.object({ a: k.string() }))
export const D = k.strictObject(fields)
`
		const outcome = restoreStrictSource('a.ts', current, base)
		expect(outcome.output).toBe(
			current
				.replace('C = k.object', 'C = k.strictObject')
				.replace('k.array(k.object', 'k.array(k.strictObject'),
		)
		expect([outcome.restored, outcome.already, outcome.manual]).toEqual([2, 1, []])
		// A plain counterpart is not rewritten on a guess; it is reported with the likely line.
		const plain = restoreStrictSource(
			'a.ts',
			current.replace('k.strictObject(fields)', 'k.object(fields)'),
			base,
		)
		expect(plain.output).not.toContain('k.strictObject(fields)')
		expect(plain.manual).toMatchObject([{ code: 'strict-unpaired', baseLine: 5, line: 6 }])
	})

	it('follows renamed namespaces and the last policy of the base chain', () => {
		const base =
			"import * as zod from 'zod'\nexport const A = zod.object({ a: zod.string() }).strict().strip()\nexport const B = zod.object({ b: zod.string() }).strip().strict()\n"
		const current =
			"import { k as kit } from 'cvx-kit/k'\nexport const A = kit.object({ a: kit.string() })\nexport const B = kit.object({ b: kit.string() })\n"
		expect(restoreStrictSource('a.ts', current, base).output).toBe(
			current.replace('B = kit.object', 'B = kit.strictObject'),
		)
	})
})

describe('cvx-kit-codemod-v2 --restore-strict', () => {
	function repository(body) {
		const root = mkdtempSync(join(tmpdir(), 'cvx-restore-'))
		const git = (...args) =>
			execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], {
				cwd: root,
				stdio: 'pipe',
			})
		const write = (path, text) => {
			mkdirSync(dirname(join(root, path)), { recursive: true })
			writeFileSync(join(root, path), text)
		}
		try {
			git('init', '-q')
			write('app/convex/a.ts', BASE)
			write('app/convex/gone.ts', BASE)
			git('add', '-A')
			git('commit', '-q', '-m', 'base')
			git('tag', 'pre-migration')
			write('app/convex/a.ts', MIGRATED)
			write('app/convex/new.ts', MIGRATED)
			git('add', '-A')
			git('commit', '-q', '-m', 'migrated')
			return body(root)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	}

	it('is a dry run without --write and reads the base from a subdirectory of the repository', () => {
		repository((root) => {
			const cwd = join(root, 'app')
			const outcome = run(['convex', '--restore-strict', 'pre-migration'], cwd)
			expect(outcome.exitCode).toBe(0)
			expect(outcome.summary).toContain('dry run')
			expect(outcome.summary).toContain('3 restored to k.strictObject')
			expect(outcome.summary).toContain('1 not present at pre-migration')
			expect(outcome.summary).toContain('convex/a.ts:7 strict-on-reference')
			expect(readFileSync(join(cwd, 'convex/a.ts'), 'utf8')).toBe(MIGRATED)
		})
	})

	it('writes the restored files and the report, and leaves files new since the base alone', () => {
		repository((root) => {
			const outcome = run(
				['app', '--restore-strict', 'pre-migration', '--write', '--report', 'restore.json'],
				root,
			)
			expect(outcome.exitCode).toBe(0)
			expect(readFileSync(join(root, 'app/convex/a.ts'), 'utf8')).toBe(RESTORED)
			expect(readFileSync(join(root, 'app/convex/new.ts'), 'utf8')).toBe(MIGRATED)
			const report = JSON.parse(readFileSync(join(root, 'restore.json'), 'utf8'))
			expect(report.restoreStrict).toBe('pre-migration')
			expect(report.files.find((file) => file.path === 'app/convex/a.ts').restored).toBe(3)
			expect(run(['app', '--restore-strict', 'pre-migration', '--write'], root).summary).toContain(
				'0 restored to k.strictObject, 3 already strict',
			)
		})
	})

	it('rejects a missing or unknown ref', () => {
		expect(() => parseArguments(['src', '--restore-strict'])).toThrow('needs a git ref')
		repository((root) => {
			expect(() => run(['app', '--restore-strict', 'no-such-ref'], root)).toThrow('is not a commit')
		})
	})
})
