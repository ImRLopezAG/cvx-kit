import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	lstatSync,
	writeFileSync,
} from 'node:fs'
import { join, resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '..')
// Run only in an explicitly owned, env-free snapshot. Never load application configuration.
for (let directory = root; ; directory = resolve(directory, '..')) {
	assert.equal(
		readdirSync(directory).some((name) => /^\.env(?:\.|$)/.test(name)),
		false,
		'Environment filename in snapshot ancestry',
	)
	if (resolve(directory, '..') === directory) break
}
const env = {
	PATH: '/opt/homebrew/bin:/usr/bin:/bin',
	HOME: process.env.HOME,
	TMPDIR: '/tmp',
	CI: '1',
}
const sourceHead =
	process.env.CVX_PACKED_SOURCE_HEAD ??
	execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8' }).trim()
assert.match(sourceHead, /^[a-f0-9]{40}$/)
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const proof = mkdtempSync('/tmp/cvx-kit-querying-')
console.log(`Packed querying retained proof: ${proof}`)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function files(directory, boundary = directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		assert.equal(
			/^\.env(?:\.|$)/.test(entry.name),
			false,
			'Environment filename in selected source tree',
		)
		const path = join(directory, entry.name)
		assert.equal(
			lstatSync(path).isSymbolicLink(),
			false,
			'Snapshot trees must contain regular files/directories',
		)
		assert.ok(realpathSync(path).startsWith(realpathSync(boundary) + '/'))
		return entry.isDirectory() ? files(path, boundary) : [path]
	})
}
function run(command, args, cwd, label) {
	const started = performance.now()
	try {
		const output = execFileSync(command, args, {
			cwd,
			env,
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
const failures = []
function check(...args) {
	try {
		return run(...args)
	} catch (error) {
		failures.push({ check: args[3], message: error.message })
		return null
	}
}
const sourceHashes = () =>
	Object.fromEntries(sourcePaths.map((p) => [p, hash(readFileSync(join(root, p)))]))
const before = sourceHashes()
writeFileSync(join(proof, 'source-before.json'), JSON.stringify(before, null, 2))
run(
	'bun',
	['--no-env-file', 'pm', 'pack', '--ignore-scripts', '--destination', proof],
	root,
	'pack',
)
const tarball = join(proof, `${manifest.name}-${manifest.version}.tgz`)
writeFileSync(
	join(proof, 'package-identity.json'),
	JSON.stringify(
		{
			name: manifest.name,
			version: manifest.version,
			tarball,
			sha256: hash(readFileSync(tarball)),
			head: sourceHead,
			files: run('tar', ['-tzf', tarball], root, 'tar-manifest').trim().split('\n'),
		},
		null,
		2,
	),
)
for (const [label, convex, helpers, zod, convexTest] of [
	['current', '1.48.0', '0.1.129', '4.6.5', '0.0.65'],
	['minimum', '1.46.0', '0.1.127', '4.5.4', '0.0.65'],
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
				convex,
				'convex-helpers': helpers,
				zod,
				typescript: '7.0.2',
				'convex-test': convexTest,
				effect: manifest.devDependencies.effect,
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
			include: ['convex/**/*.ts', 'types.ts', 'runtime.ts', 'focused.ts', 'search.ts'],
		}),
	)
	run('bun', ['--no-env-file', 'install', '--ignore-scripts'], fixture, `${label}-install`)
	const versions = Object.fromEntries(
		['cvx-kit', 'convex', 'convex-helpers', 'zod', 'typescript', 'convex-test'].map((name) => [
			name,
			JSON.parse(readFileSync(join(fixture, 'node_modules', name, 'package.json'), 'utf8')).version,
		]),
	)
	writeFileSync(join(fixture, 'versions.json'), JSON.stringify(versions, null, 2))
	check(
		'node',
		[join(fixture, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.json'],
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
	check(
		join(fixture, 'node_modules/.bin/oxlint'),
		['--config', '.oxlintrc.json', 'convex'],
		fixture,
		`${label}-consumer-lint`,
	)
	const tests = files(join(fixture, 'convex'))
		.filter((p) => p.endsWith('.test.ts'))
		.map((p) => relative(fixture, p))
	assert.equal(tests.length, 3)
	check(
		'node',
		['--import', './register.mjs', '--test', ...tests],
		fixture,
		`${label}-colocated-tests`,
	)
	check('node', ['--import', './register.mjs', 'search.ts'], fixture, `${label}-search`)
	check('node', ['--import', './register.mjs', 'runtime.ts'], fixture, `${label}-runtime`)
	check('node', ['--import', './register.mjs', 'focused.ts'], fixture, `${label}-focused`)
}
const after = sourceHashes()
writeFileSync(join(proof, 'source-after.json'), JSON.stringify(after, null, 2))
assert.deepEqual(after, before, 'source must stay fixed during packed verification')
writeFileSync(join(proof, 'failures.json'), JSON.stringify(failures, null, 2))
assert.equal(failures.length, 0, `Packed proof failures retained at ${proof}`)
writeFileSync(join(proof, 'SUCCESS'), 'Both strict packed peers and full runtime stress passed.\n')
console.log(`Packed querying complete. Evidence retained at ${proof}`)
