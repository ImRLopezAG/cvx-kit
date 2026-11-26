// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
				.trim()
				.split('\n')
				.map((file) => file.replace(/^package\//, ''))
				.sort()
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
	it('ships the README, the changelog and the skill references, not the rest of the repository', () => {
		expect(packedFiles).toContain('README.md')
		expect(packedFiles).toContain('CHANGELOG.md')
		const references = readdirSync(join(process.cwd(), 'skills/cvx-kit/references'))
			.filter((name) => name.endsWith('.md'))
			.map((name) => `skills/cvx-kit/references/${name}`)
			.sort()
		expect(packedFiles.filter((file) => file.startsWith('skills/'))).toEqual(references)
		expect(packedFiles.filter((file) => /^(docs|scripts)\//.test(file))).toEqual([])
		expect(packedFiles).not.toContain('AGENTS.md')
	})
	it('ships the v2 codemod as a bin, without its fixtures', () => {
		const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
		expect(manifest.bin).toEqual({ 'cvx-kit-codemod-v2': './tools/codemod-v2/index.mjs' })
		const codemod = packedFiles.filter((file) => file.startsWith('tools/'))
		expect(codemod).toContain('tools/codemod-v2/index.mjs')
		expect(codemod).toContain('tools/codemod-v2/transforms/schema.mjs')
		expect(
			codemod.every((file) => /^tools\/codemod-v2\/(transforms\/)?[\w-]+\.mjs$/.test(file)),
		).toBe(true)
		expect(codemod.some((file) => file.includes('fixtures'))).toBe(false)
		const sources = codemod.map((file) => readFileSync(join(process.cwd(), file), 'utf8'))
		const imports = sources.flatMap((source) =>
			[...source.matchAll(/^import [^'\n]*'([^']+)'/gm)].map((match) => match[1]),
		)
		const runtime = Object.keys(manifest.dependencies)
		for (const specifier of imports)
			expect(
				specifier.startsWith('.') || specifier.startsWith('node:') || runtime.includes(specifier),
				specifier,
			).toBe(true)
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
	it('ships the v2 entries, no v1 entry and no v1 build output', () => {
		const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
		for (const stem of ['k', 'table', 'registration', 'json-schema', 'zod']) {
			expect(manifest.exports[`./${stem}`]).toEqual({
				types: `./dist/${stem}.d.mts`,
				import: `./dist/${stem}.mjs`,
			})
			expect(packedFiles).toContain(`dist/${stem}.mjs`)
			expect(packedFiles).toContain(`dist/${stem}.d.mts`)
		}
		expect(manifest.exports['./zod-table']).toBeUndefined()
		expect(
			packedFiles.filter((file) =>
				/^dist\/(zod-(table|registration|convex)|querying\/v1-zod-[^/]*)\./.test(file),
			),
		).toEqual([])
		// A string export is its own target; a conditional one lists every target.
		for (const target of Object.values(manifest.exports).flatMap((entry) =>
			entry.types === undefined ? [entry] : Object.values(entry),
		))
			expect(packedFiles, target).toContain(target.replace(/^\.\//, ''))
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
		expect(
			packedFiles.filter(
				(file) => file.startsWith('tools/') && !file.startsWith('tools/codemod-v2/'),
			),
		).toEqual([])
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
