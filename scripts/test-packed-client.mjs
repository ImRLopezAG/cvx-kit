import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
const root = resolve(import.meta.dirname, '..')
assert.equal(existsSync(join(root, '.env')), false, 'Run only in a nonsecret source snapshot')
const proof = mkdtempSync('/tmp/cvx-u8-packed-')
console.log(`U8 packed proof: ${proof}`)
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
for (const [label, helpers, zod, react, reactTypes] of [
	['current', '0.1.128', '4.6.5', '19.2.8', '19.2.2'],
	['minimum', '0.1.127', '4.5.4', '18.0.0', '18.0.0'],
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
				react,
				'react-dom': react,
				'@types/react': reactTypes,
				'@types/react-dom': reactTypes,
				'@types/scheduler': '0.16.8',
				effect: '4.0.2',
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
			include: ['*.ts', '*.tsx'],
		}),
	)
	writeFileSync(
		join(fixture, 'react.tsx'),
		readFileSync(join(root, 'test/fixture-packed-client/react.tsx'), 'utf8')
			.replaceAll('../../src/react', 'cvx-kit/react')
			.replaceAll('../../src/errors', 'cvx-kit/errors'),
	)
	run('bun', ['--no-env-file', 'install', '--ignore-scripts'], fixture, label + '-install')
	writeFileSync(
		join(fixture, 'versions.json'),
		JSON.stringify(
			Object.fromEntries(
				[
					'convex',
					'convex-helpers',
					'zod',
					'typescript',
					'convex-test',
					'react',
					'react-dom',
					'@types/react',
					'@types/react-dom',
				].map((n) => [
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
	cpSync(
		join(root, 'test/fixture-packed-client/failures.ts.template'),
		join(fixture, 'failures.ts'),
	)
	run('node', ['node_modules/typescript/bin/tsc', '--noEmit'], fixture, label + '-failure-types')
	run('node', ['--import', './register.mjs', 'failures.ts'], fixture, label + '-raw-failures')

	const reactBundle = await build({
		entryPoints: [join(fixture, 'react.tsx')],
		bundle: true,
		platform: 'browser',
		format: 'esm',
		target: 'es2022',
		write: false,
		metafile: true,
		treeShaking: false,
		define: { 'process.env.NODE_ENV': '"production"' },
	})
	const reactInputs = Object.keys(reactBundle.metafile.inputs)
	assert.ok(reactInputs.some((p) => p.includes('cvx-kit/dist/react')))
	const clientSharedConvex = new Set(['functionName.js', 'components/paths.js', 'api.js'])
	for (const path of reactInputs) {
		const serverPart = path.split('/convex/dist/esm/server/')[1]
		if (serverPart !== undefined)
			assert.ok(clientSharedConvex.has(serverPart), `Unexpected Convex server module: ${path}`)
		assert.doesNotMatch(path, /cvx-kit\/dist\/querying\//)
	}
	for (const path of reactInputs)
		assert.doesNotMatch(
			path,
			/convex-helpers\/.*server|crypto|tenancy|querying\/(?:executor|registry|security|cursor)/,
		)
	for (const file of reactBundle.outputFiles)
		assert.doesNotMatch(
			file.text,
			/process\.env|CVX_QUERY_CURSOR|createQueryEngine|defineRelations/,
		)
	writeFileSync(
		join(proof, label + '-react-browser-graph.json'),
		JSON.stringify(reactBundle.metafile, null, 2),
	)
	writeFileSync(join(proof, label + '-react-browser.mjs'), reactBundle.outputFiles[0].text)
	console.log(`${label}: strict types, filter + React browser graphs and registered runtime passed`)
}

const serverOnly = join(proof, 'server-without-react')
mkdirSync(serverOnly)
writeFileSync(
	join(serverOnly, 'package.json'),
	JSON.stringify({
		type: 'module',
		private: true,
		dependencies: {
			'cvx-kit': `file:${tarball}`,
			convex: '1.46.0',
			'convex-helpers': '0.1.127',
			zod: '4.5.4',
			typescript: '7.0.2',
			'@types/node': '26.6.5',
		},
	}),
)
run(
	'bun',
	['--no-env-file', 'install', '--ignore-scripts', '--omit', 'peer'],
	serverOnly,
	'server-without-react-install',
)
assert.equal(existsSync(join(serverOnly, 'node_modules/react')), false)
assert.equal(existsSync(join(serverOnly, 'node_modules/@types/react')), false)
writeFileSync(
	join(serverOnly, 'server.ts'),
	`import { defineErrorContract, decodeFailure } from 'cvx-kit/errors'
import { createAuthFunctions } from 'cvx-kit/auth'
import { createQueryEngine, queryFailureContract } from 'cvx-kit/querying'
const contract = defineErrorContract({ DENIED: { message: 'Denied', details: {} } })
if (decodeFailure(new Error('private'), contract)._tag !== 'UnknownFailure') throw Error('unsafe')
void [createAuthFunctions, createQueryEngine, queryFailureContract]
`,
)
writeFileSync(
	join(serverOnly, 'tsconfig.json'),
	JSON.stringify({
		compilerOptions: {
			strict: true,
			skipLibCheck: false,
			noEmit: true,
			target: 'ES2025',
			module: 'ESNext',
			moduleResolution: 'bundler',
			types: ['node'],
		},
		include: ['*.ts'],
	}),
)
run(
	'node',
	['node_modules/typescript/bin/tsc', '--noEmit'],
	serverOnly,
	'server-without-react-types',
)
run('node', ['server.ts'], serverOnly, 'server-without-react-runtime')
writeFileSync(join(proof, 'SUCCESS'), 'Current and minimum peers passed\n')
