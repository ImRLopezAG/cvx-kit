// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

const packedFiles = (() => {
	const env = { ...process.env }
	delete env.NODE_AUTH_TOKEN
	delete env.NPM_CONFIG_USERCONFIG
	const installer = env.CVX_PACKED_INSTALLER ?? 'npm'
	if (!['bun', 'npm'].includes(installer))
		throw new Error('CVX_PACKED_INSTALLER must be bun or npm')
	if (installer === 'bun') {
		const temporary = mkdtempSync(join(tmpdir(), 'cvx-kit-contents-'))
		try {
			const tarball = join(temporary, 'package.tgz')
			execFileSync('bun', ['pm', 'pack', '--ignore-scripts', '--filename', tarball], {
				cwd: process.cwd(),
				env,
				stdio: 'pipe',
			})
			return execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
				.trim().split('\n').map((file) => file.replace(/^package\//, '')).sort()
		} finally {
			rmSync(temporary, { recursive: true, force: true })
		}
	}
	// Keep npm's published manifest compatibility check available locally.
	const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--force'], {
		cwd: process.cwd(),
		encoding: 'utf8',
		env,
	})
	const result = JSON.parse(output)
	const pack = Array.isArray(result) ? result[0] : result.files ? result : Object.values(result)[0]
	if (!pack?.files) throw new Error('npm pack returned no package manifest')
	return pack.files.map((file) => file.path)
})()

describe('packed Convex components', () => {
	it('ships the README while keeping full documentation and skills on GitHub', () => {
		expect(packedFiles).toContain('README.md')
		expect(packedFiles.filter((file) => /^(docs|skills|scripts)\//.test(file))).toEqual([])
		expect(packedFiles).not.toContain('AGENTS.md')
	})
	it('ships deliberate relations and querying facades', () => {
		const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
		for (const [path, stem] of [
			['./relations', 'relations-public'],
			['./querying', 'querying'],
		]) {
			expect(manifest.exports[path]).toEqual({
				types: `./dist/${stem}.d.mts`,
				import: `./dist/${stem}.mjs`,
			})
			expect(packedFiles).toContain(`dist/${stem}.mjs`)
			expect(packedFiles).toContain(`dist/${stem}.d.mts`)
		}
		for (const path of [
			'./querying/security',
			'./querying/cursors',
			'./relations-public',
			'./dist/relations.mjs',
		])
			expect(manifest.exports[path]).toBeUndefined()
	})
	it('keeps the optional Effect peer outside Convex component discovery', () => {
		for (const file of packedFiles.filter((path) => /^dist\/components\/.*\.mjs$/.test(path))) {
			const source = readFileSync(join(process.cwd(), file), 'utf8')
			expect(source, file).not.toMatch(/(?:from|import)\s*["']effect(?:\/[\w/-]+)?["']/)
		}
		expect(packedFiles).toContain('dist/effect.mjs')
	})
	it('excludes internal planning and reproduction artifacts', () => {
		expect(
			packedFiles.filter((file) => /^docs\/(explain|ideation|plans|reproductions)\//.test(file)),
		).toEqual([])
	})
	it('ships the compiled plugin and types without repository tooling', () => {
		expect(packedFiles).toContain('dist/oxlint.mjs')
		expect(packedFiles).toContain('dist/oxlint.d.mts')
		expect(packedFiles.filter((file) => file.startsWith('tools/'))).toEqual([])
	})
	it.each(['approvals', 'foundation'])(
		'publishes one discoverable schema module for %s',
		(component) => {
			const prefix = `dist/components/${component}/schema.`
			const schemas = packedFiles.filter((file) => file.startsWith(prefix))
			expect(schemas).toEqual([
				`dist/components/${component}/schema.d.ts`,
				`dist/components/${component}/schema.js`,
			])
		},
	)

	it('points the shipped test helper at the discoverable schemas', () => {
		const source = readFileSync(join(process.cwd(), 'src/test.ts'), 'utf8')
		expect(source).toContain('../dist/components/approvals/schema.js')
		expect(source).toContain('../dist/components/foundation/schema.js')
		expect(source).not.toMatch(/schema\.mjs/)
	})

	it.each(['approvals', 'foundation'])(
		'keeps generated data-model types aligned with the %s schema filename',
		(component) => {
			const declaration = readFileSync(
				join(process.cwd(), 'dist', 'components', component, '_generated', 'dataModel.d.mts'),
				'utf8',
			)
			expect(declaration).toContain('../schema.js')
			expect(declaration).not.toContain('../schema.mjs')
		},
	)

	it('rewrites runtime imports to the discoverable approvals schema', () => {
		const requests = readFileSync(
			join(process.cwd(), 'dist', 'components', 'approvals', 'requests.mjs'),
			'utf8',
		)
		expect(requests).toContain('./schema.js')
		expect(requests).not.toContain('./schema.mjs')
	})
})
