// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vite-plus/test'

it.each([true, false])('extracts complete notes with capital Z (following version: %s)', (hasNext) => {
	const root = mkdtempSync(join(tmpdir(), 'cvx-changelog-'))
	try {
		mkdirSync(join(root, 'scripts'))
		const script = join(root, 'scripts/extract-changelog.mjs')
		copyFileSync('scripts/extract-changelog.mjs', script)
		const notes = '### Fixed\n\n- Keep zodToZod and Zod intact.\n- Keep the final line.'
		writeFileSync(join(root, 'CHANGELOG.md'), `# Changelog\n\n## [0.1.3] - 2026-09-06\n\n${notes}\n${hasNext ? '\n## [0.1.2]\n\nOlder notes.\n' : ''}`)
		expect(execFileSync('node', [script, '0.1.3'], { encoding: 'utf8' })).toBe(`${notes}\n`)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
