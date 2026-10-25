import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
const root = resolve(import.meta.dirname, '..')
assert.equal(existsSync(join(root, '.env')), false, 'Run only in a nonsecret source snapshot')
const proof = mkdtempSync('/tmp/cvx-u7-packed-')
console.log(`U7 packed proof: ${proof}`)
function run(command, args, cwd, label) {
	try {
		const out = execFileSync(command, args, {
			cwd,
			encoding: 'utf8',
			timeout: 1200000,
			maxBuffer: 32 * 1024 * 1024,
		})
		writeFileSync(join(proof, label + '.log'), out)
		return out
	} catch (e) {
		writeFileSync(
			join(proof, label + '.log'),
			label.endsWith('install')
				? `Install failed: ${e.status}`
				: `${e.stdout ?? ''}\n${e.stderr ?? ''}`,
		)
		throw new Error(`${label} failed; ${proof}`, { cause: e.status })
	}
}
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
run(
	'bun',
	['--no-env-file', 'pm', 'pack', '--ignore-scripts', '--destination', proof],
	root,
	'pack',
)
const tarball = join(proof, `${manifest.name}-${manifest.version}.tgz`)
writeFileSync(
	join(proof, 'tarball.json'),
	JSON.stringify(
		{ tarball, sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') },
		null,
		2,
	),
)
for (const [label, helpers, zod] of [
	['current', '0.1.128', '4.6.5'],
	['minimum', '0.1.127', '4.5.4'],
]) {
	const fixture = join(proof, label)
	mkdirSync(fixture)
	writeFileSync(
		join(fixture, 'package.json'),
		JSON.stringify({
			type: 'module',
			private: true,
			dependencies: {
				'cvx-kit': `file:${tarball}`,
				convex: '1.46.0',
				'convex-helpers': helpers,
				zod,
				typescript: '7.0.2',
				'convex-test': '0.0.61',
				'@types/node': '26.6.5',
			},
		}),
	)
	writeFileSync(
		join(fixture, 'filters.ts'),
		readFileSync(join(root, 'test/fixture-packed-client/filters.ts'), 'utf8').replace(
			'../../src/filters',
			'cvx-kit/filters',
		),
	)
	cpSync(join(root, 'test/fixture-packed-client/server.ts.template'), join(fixture, 'server.ts'))
	cpSync(
		join(root, 'test/fixture-packed-querying/register.mjs.template'),
		join(fixture, 'register.mjs'),
	)
	writeFileSync(
		join(fixture, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				skipLibCheck: false,
				noEmit: true,
				target: 'ES2025',
				module: 'ESNext',
				moduleResolution: 'bundler',
				allowImportingTsExtensions: true,
				types: ['node'],
			},
			include: ['*.ts'],
		}),
	)
	run('bun', ['--no-env-file', 'install', '--ignore-scripts'], fixture, label + '-install')
	writeFileSync(
		join(fixture, 'versions.json'),
		JSON.stringify(
			Object.fromEntries(
				['convex', 'convex-helpers', 'zod', 'typescript', 'convex-test'].map((n) => [
					n,
					JSON.parse(readFileSync(join(fixture, 'node_modules', n, 'package.json'), 'utf8'))
						.version,
				]),
			),
			null,
			2,
		),
	)
	run('node', ['node_modules/typescript/bin/tsc', '--noEmit'], fixture, label + '-types')
	const result = await build({
		entryPoints: [join(fixture, 'filters.ts')],
		bundle: true,
		platform: 'browser',
		format: 'esm',
		target: 'es2022',
		write: false,
		metafile: true,
		treeShaking: false,
	})
	const inputs = Object.keys(result.metafile.inputs)
	assert.ok(inputs.some((p) => p.includes('cvx-kit/dist/filters')))
	for (const path of inputs)
		assert.doesNotMatch(
			path,
			/convex\/.*server|convex-helpers\/.*server|crypto|tenancy|querying\/(?:executor|registry|security|cursor)/,
		)
	for (const output of result.outputFiles)
		assert.doesNotMatch(
			output.text,
			/process\.env|CVX_QUERY_CURSOR|createQueryEngine|defineRelations/,
		)
	writeFileSync(
		join(proof, label + '-browser-graph.json'),
		JSON.stringify(result.metafile, null, 2),
	)
	writeFileSync(join(proof, label + '-browser.mjs'), result.outputFiles[0].text)
	run('node', ['--import', './register.mjs', 'server.ts'], fixture, label + '-runtime')
	console.log(`${label}: strict types, browser bundler graph and registered runtime passed`)
}
writeFileSync(join(proof, 'SUCCESS'), 'Current and minimum peers passed\n')
