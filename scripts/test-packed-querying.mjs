import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const proof = mkdtempSync('/tmp/cvx-kit-querying-')
console.log(`U8 retained proof: ${proof}`)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function files(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name)
		return entry.isDirectory() ? files(path) : [path]
	})
}
function run(command, args, cwd, label) {
	const started = performance.now()
	try {
		const output = execFileSync(command, args, {
			cwd,
			encoding: 'utf8',
			stdio: 'pipe',
			timeout: 1200000,
			maxBuffer: 32 * 1024 * 1024,
		})
		writeFileSync(join(proof, `${label}.log`), output)
		console.log(`${label}: exit 0 (${((performance.now() - started) / 1000).toFixed(2)}s)`)
		return output
	} catch (error) {
		// Install output may contain credentials from caller's package-manager setup.
		if (label.endsWith('install'))
			writeFileSync(join(proof, `${label}.log`), `Install failed: exit ${error.status}\n`)
		else writeFileSync(join(proof, `${label}.log`), `${error.stdout ?? ''}\n${error.stderr ?? ''}`)
		throw new Error(`${label} failed; evidence retained at ${proof}`, { cause: error.status })
	}
}
const sourcePaths = [
	'README.md',
	'package.json',
	'vite.config.ts',
	...files(join(root, 'src'))
		.filter((p) => p.endsWith('.ts'))
		.map((p) => relative(root, p)),
	...files(join(root, 'test/fixture-packed-querying')).map((p) => relative(root, p)),
	'scripts/test-packed-querying.mjs',
	'scripts/smoke-packed-querying.mjs',
	'scripts/owned-process.mjs',
	'scripts/owned-process.test.mjs',
	'scripts/test-packed-oxlint.mjs',
]
const sourceHashes = () =>
	Object.fromEntries(sourcePaths.map((p) => [p, hash(readFileSync(join(root, p)))]))
const before = sourceHashes()
writeFileSync(join(proof, 'source-before.json'), JSON.stringify(before, null, 2))
run('bun', ['pm', 'pack', '--ignore-scripts', '--destination', proof], root, 'pack')
const tarball = join(proof, `${manifest.name}-${manifest.version}.tgz`)
writeFileSync(
	join(proof, 'package-identity.json'),
	JSON.stringify(
		{
			name: manifest.name,
			version: manifest.version,
			tarball,
			sha256: hash(readFileSync(tarball)),
			head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
			files: run('tar', ['-tzf', tarball], root, 'tar-manifest').trim().split('\n'),
		},
		null,
		2,
	),
)
for (const [label, helpers, zod] of [
	['installed', '0.1.128', '4.6.5'],
	['minimum', '0.1.127', '4.5.4'],
]) {
	const fixture = join(proof, label)
	mkdirSync(fixture)
	writeFileSync(
		join(fixture, 'package.json'),
		JSON.stringify({
			private: true,
			type: 'module',
			dependencies: {
				'cvx-kit': `file:${tarball}`,
				convex: '1.46.0',
				'convex-helpers': helpers,
				zod,
				typescript: '7.0.2',
				'convex-test': '0.0.61',
				'@types/node': manifest.devDependencies['@types/node'],
				oxlint: manifest.devDependencies.oxlint,
			},
		}),
	)
	const templates = join(root, 'test/fixture-packed-querying')
	for (const source of files(templates)) {
		const destination = join(fixture, relative(templates, source).replace(/\.template$/, ''))
		mkdirSync(resolve(destination, '..'), { recursive: true })
		cpSync(source, destination)
	}
	mkdirSync(join(fixture, 'convex/_generated'), { recursive: true })
	writeFileSync(
		join(fixture, 'convex/_generated/dataModel.ts'),
		`import type {DataModelFromSchemaDefinition} from 'convex/server'; import schema from '../schema'; export type DataModel = DataModelFromSchemaDefinition<typeof schema>\n`,
	)
	writeFileSync(
		join(fixture, 'convex/_generated/server.ts'),
		`import {queryGeneric, mutationGeneric, actionGeneric, internalQueryGeneric, internalMutationGeneric, internalActionGeneric, type GenericQueryCtx} from 'convex/server'; import type {DataModel} from './dataModel'; export const query = queryGeneric; export const mutation = mutationGeneric; export const action = actionGeneric; export const internalQuery = internalQueryGeneric; export const internalMutation = internalMutationGeneric; export const internalAction = internalActionGeneric; export type QueryCtx = GenericQueryCtx<DataModel>\n`,
	)
	writeFileSync(
		join(fixture, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				types: ['node'],
				skipLibCheck: false,
				noEmit: true,
				target: 'ES2025',
				module: 'ESNext',
				moduleResolution: 'bundler',
				allowImportingTsExtensions: true,
			},
			include: ['convex/**/*.ts', 'types.ts', 'runtime.ts', 'focused.ts'],
		}),
	)
	run('bun', ['install', '--ignore-scripts'], fixture, `${label}-install`)
	const versions = Object.fromEntries(
		['cvx-kit', 'convex', 'convex-helpers', 'zod', 'typescript', 'convex-test'].map((name) => [
			name,
			JSON.parse(readFileSync(join(fixture, 'node_modules', name, 'package.json'), 'utf8')).version,
		]),
	)
	writeFileSync(join(fixture, 'versions.json'), JSON.stringify(versions, null, 2))
	run(
		join(fixture, 'node_modules/.bin/tsc'),
		['--project', 'tsconfig.json'],
		fixture,
		`${label}-types`,
	)
	const consumerRules = JSON.parse(
		run(
			'node',
			[
				'--input-type=module',
				'-e',
				"import plugin from 'cvx-kit/oxlint'; console.log(JSON.stringify(Object.keys(plugin.rules)))",
			],
			fixture,
			`${label}-consumer-rules`,
		),
	)
	assert.equal(consumerRules.length, 23, 'Run every exported packaged consumer rule')
	writeFileSync(
		join(fixture, '.oxlintrc.json'),
		JSON.stringify({
			jsPlugins: [{ name: 'cvx', specifier: 'cvx-kit/oxlint' }],
			rules: Object.fromEntries(consumerRules.map((r) => [`cvx/${r}`, 'error'])),
		}),
	)
	run(
		join(fixture, 'node_modules/.bin/oxlint'),
		['--config', '.oxlintrc.json', 'convex'],
		fixture,
		`${label}-consumer-lint`,
	)
	const tests = files(join(fixture, 'convex'))
		.filter((p) => p.endsWith('.test.ts'))
		.map((p) => relative(fixture, p))
	assert.equal(tests.length, 3)
	run(
		'node',
		['--import', './register.mjs', '--test', ...tests],
		fixture,
		`${label}-colocated-tests`,
	)
	run('node', ['--import', './register.mjs', 'runtime.ts'], fixture, `${label}-runtime`)
	run('node', ['--import', './register.mjs', 'focused.ts'], fixture, `${label}-focused`)
}
const after = sourceHashes()
writeFileSync(join(proof, 'source-after.json'), JSON.stringify(after, null, 2))
assert.deepEqual(after, before, 'source must stay fixed during packed verification')
writeFileSync(join(proof, 'SUCCESS'), 'Both strict packed peers and full runtime stress passed.\n')
console.log(`Packed querying complete. Evidence retained at ${proof}`)
