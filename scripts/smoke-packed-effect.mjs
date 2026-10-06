import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	assertIsolatedConvexFixture,
	assertLocalConvexState,
	localConvexEnvironment,
} from './convex-smoke-env.mjs'

const root = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const installer = process.argv[2] ?? 'bun'
if (!['bun', 'npm'].includes(installer)) throw new Error('Usage: smoke-packed-effect.mjs [bun|npm]')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'cvx-kit-effect-runtime-'))
const fixture = join(temporaryRoot, 'fixture')
function run(command, args, cwd = fixture) {
	try {
		return execFileSync(command, args, {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			env: localConvexEnvironment(),
		})
	} catch (error) {
		if (args[0] === 'install')
			throw new Error(
				`Isolated ${command} install failed with exit ${error.status ?? 'unknown'}; package-manager output suppressed`,
			)
		throw error
	}
}
function convex(...args) {
	return run('node', [join(fixture, 'node_modules/convex/bin/main.js'), ...args])
}
function invoke(name, args = {}) {
	return JSON.parse(
		convex('run', name.includes(':') ? name : `functions:${name}`, JSON.stringify(args)),
	)
}
function rejection(name, args, expected) {
	assert.throws(
		() => invoke(name, args),
		(error) => {
			const message = String(error.stderr)
			assert.match(message, expected)
			assert.doesNotMatch(message, /PROJECTION_MUST_NOT_RUN/)
			return true
		},
	)
}
async function freePort() {
	const server = createServer()
	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', resolve)
	})
	const port = server.address().port
	await new Promise((resolve) => server.close(resolve))
	return port
}
try {
	console.log('Effect runtime smoke: pack current built artifact (no build)')
	run('bun', ['pm', 'pack', '--destination', temporaryRoot, '--ignore-scripts'], root)
	mkdirSync(fixture)
	cpSync(join(root, 'test/fixture-effect/convex'), join(fixture, 'convex'), { recursive: true })
	// Generate from scratch so removed generated files cannot survive the fixture copy.
	rmSync(join(fixture, 'convex/_generated'), { recursive: true, force: true })
	writeFileSync(
		join(fixture, 'package.json'),
		JSON.stringify(
			{
				private: true,
				type: 'module',
				dependencies: {
					'cvx-kit': `file:${join(temporaryRoot, `cvx-kit-${manifest.version}.tgz`)}`,
					convex: manifest.devDependencies.convex,
					effect: manifest.devDependencies.effect,
					zod: manifest.devDependencies.zod,
					'convex-helpers': manifest.devDependencies['convex-helpers'],
				},
				devDependencies: {
					typescript: manifest.devDependencies.typescript,
					'@types/node': manifest.devDependencies['@types/node'],
				},
			},
			null,
			2,
		),
	)
	writeFileSync(
		join(fixture, 'tsconfig.json'),
		JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2025',
					lib: ['ES2025', 'DOM'],
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: true,
					noEmit: true,
					skipLibCheck: false,
					types: ['node'],
				},
				include: ['convex', 'typecheck.ts'],
			},
			null,
			2,
		),
	)
	cpSync(join(root, 'test/fixture-effect/typecheck.ts'), join(fixture, 'typecheck.ts'))
	console.log(`Effect runtime smoke: isolated ${installer} install`)
	run(installer, ['install', '--ignore-scripts'])
	assertIsolatedConvexFixture(fixture)
	const cloudPort = await freePort()
	let sitePort = await freePort()
	while (sitePort === cloudPort) sitePort = await freePort()
	console.log('Effect runtime smoke: deploy isolated local Convex fixture')
	convex(
		'dev',
		'--once',
		'--typecheck=disable',
		'--local-cloud-port',
		String(cloudPort),
		'--local-site-port',
		String(sitePort),
	)
	assertLocalConvexState(fixture)
	convex('codegen', '--typecheck=disable')
	const generated = join(fixture, 'convex/_generated')
	const committed = join(root, 'test/fixture-effect/convex/_generated')
	const regenerateMessage = 'Generated contracts differ; regenerate the Effect fixture contracts'
	assert.deepEqual(readdirSync(generated).sort(), readdirSync(committed).sort(), regenerateMessage)
	for (const file of readdirSync(generated)) {
		assert.equal(
			readFileSync(join(generated, file), 'utf8'),
			readFileSync(join(committed, file), 'utf8'),
			`${regenerateMessage}: ${file}`,
		)
	}
	console.log('Effect runtime smoke: strict generated contracts and packed declarations')
	run('node', [join(fixture, 'node_modules/typescript/bin/tsc'), '--noEmit'])
	const localConfig = JSON.parse(
		readFileSync(join(fixture, '.convex/local/default/config.json'), 'utf8'),
	)
	console.log(
		`Runtime versions: Convex CLI ${manifest.devDependencies.convex}; Effect ${manifest.devDependencies.effect}; backend ${localConfig.backendVersion ?? 'not recorded by CLI'}`,
	)
	assert.equal(invoke('save', { key: 'success', mode: 'success' }), 'saved')
	assert.deepEqual(invoke('read', { key: 'success' }), ['domain', 'audit', 'completion'])
	assert.deepEqual(invoke('composed', { key: 'success' }), {
		count: 6,
		events: ['acquire', 'handler', 'release'],
	})
	rejection('save', { key: 'invalid-args', mode: 'unknown' }, /ArgumentValidationError/)
	assert.deepEqual(invoke('read', { key: 'invalid-args' }), [])
	rejection('invalidReturn', { key: 'invalid-return' }, /ReturnsValidationError/)
	assert.deepEqual(invoke('read', { key: 'invalid-return' }), [])
	rejection('invalidCustomReturn', { key: 'invalid-custom-return' }, /FIXTURE_CUSTOM_RETURN/)
	assert.deepEqual(invoke('read', { key: 'invalid-custom-return' }), [])
	for (const mode of ['domain', 'audit', 'completion']) {
		rejection('save', { key: mode, mode }, new RegExp(`FIXTURE_${mode}`))
		assert.deepEqual(invoke('read', { key: mode }), [])
	}
	rejection('cleanupFailure', { composite: false }, /FIXTURE_CLEANUP/)
	assert.deepEqual(invoke('read', { key: 'cleanup' }), [])
	rejection('cleanupFailure', { composite: true }, /Effect API execution failed/)
	assert.deepEqual(invoke('read', { key: 'cleanup' }), [])
	assert.deepEqual(invoke('actions:orchestrate', { key: 'action' }), {
		body: 'fixture-http-ok',
		stages: ['domain', 'audit', 'completion'],
		rejected: true,
	})
	console.log(
		'Actual local runtime passed: async query ordinary/gen/fn composition, spans, awaited scoped release, domain/audit/completion rollback, projected rejection, cleanup/composite rejection, HTTP action and separate transaction commits',
	)
} catch (error) {
	if (error.stdout) process.stderr.write(String(error.stdout))
	if (error.stderr) process.stderr.write(String(error.stderr))
	throw error
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true })
}
