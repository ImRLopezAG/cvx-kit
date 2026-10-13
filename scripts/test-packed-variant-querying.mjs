import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { runOwnedProcess, collectOwnedCleanup } from './owned-process.mjs'
import {
	localConvexEnvironment,
	assertIsolatedConvexFixture,
	assertLocalConvexState,
} from './convex-smoke-env.mjs'

const root = resolve(import.meta.dirname, '..')
const templates = join(root, 'test/fixture-packed-variant-querying')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function files(directory, skipDependencies = false) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (skipDependencies && entry.isDirectory() && entry.name === 'node_modules') return []
		const path = join(directory, entry.name)
		return entry.isDirectory() ? files(path, skipDependencies) : [path]
	})
}
function selfCheck() {
	const sources = files(templates)
	assert.ok(sources.some((path) => path.endsWith('types.ts.template')))
	assert.ok(sources.some((path) => path.endsWith('verify.mjs')))
	for (const path of sources.filter((path) => path.endsWith('.ts.template'))) {
		const raw = readFileSync(path, 'utf8')
		stripTypeScriptTypes(raw)
		const source = raw.replace(/\/\/[^\n]*/g, '')
		assert.doesNotMatch(
			source,
			/\bany\b|\bas\s+(?!const\b)|registerQueryReader|cvx-kit\/(?:src|dist)|\.\.\/.*src\//,
			relative(templates, path),
		)
	}
	assert.ok(
		readFileSync(join(templates, 'types.ts.template'), 'utf8').split('@ts-expect-error').length >=
			12,
	)
	assert.equal(
		sources.some((path) => path.includes('_generated')),
		false,
	)
	console.log(
		'Variant native fixture structural self-check passed (no install/codegen/runtime performed)',
	)
}
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
	console.log(
		'Usage: node scripts/test-packed-variant-querying.mjs [--package cvx-kit@EXACT_VERSION | --self-check]\nDefault packs the existing built artifact without building. Registry mode never falls back to the checkout. Both modes run current peers and minimum helpers/Zod peers on isolated native backends.',
	)
	process.exit(0)
}
if (args.length === 1 && args[0] === '--self-check') {
	selfCheck()
	process.exit(0)
}
let registry
if (args.length) {
	assert.equal(args.length, 2, 'Use --package cvx-kit@EXACT_VERSION or --self-check')
	assert.equal(args[0], '--package')
	assert.match(
		args[1],
		/^cvx-kit@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
		'Registry proof requires an explicit version',
	)
	registry = args[1]
}
selfCheck()
const proof = mkdtempSync(join(tmpdir(), 'cvx-kit-variant-querying-'))
console.log(`Variant shared-engine retained proof: ${proof}`)
const environment = localConvexEnvironment()
function run(command, arguments_, cwd, label) {
	try {
		const output = execFileSync(command, arguments_, {
			cwd,
			env: environment,
			encoding: 'utf8',
			stdio: 'pipe',
			timeout: 180000,
			maxBuffer: 8 * 1024 * 1024,
		})
		// Never retain package-manager output; it can include caller registry credentials.
		if (!label.endsWith('install') && !label.endsWith('pack'))
			writeFileSync(join(proof, `${label}.log`), output)
		console.log(`${label}: passed`)
		return output
	} catch (error) {
		if (!label.endsWith('install') && !label.endsWith('pack'))
			writeFileSync(join(proof, `${label}.log`), `${error.stdout ?? ''}\n${error.stderr ?? ''}`)
		throw new Error(`${label} failed (exit ${error.status ?? 'unknown'}); proof at ${proof}`)
	}
}
let tarball
if (registry) {
	// Download exactly the requested published artifact. No checkout/build fallback is permitted.
	const packed = JSON.parse(
		run(
			'npm',
			['pack', registry, '--ignore-scripts', '--json', '--pack-destination', proof],
			proof,
			'registry-pack',
		),
	)
	assert.equal(packed.length, 1)
	assert.equal(packed[0].name, 'cvx-kit')
	assert.equal(`cvx-kit@${packed[0].version}`, registry)
	tarball = join(proof, packed[0].filename)
} else {
	run('bun', ['pm', 'pack', '--ignore-scripts', '--destination', proof], root, 'local-pack')
	tarball = join(proof, `${manifest.name}-${manifest.version}.tgz`)
}
const ownedSources = [join(root, 'scripts/test-packed-variant-querying.mjs'), ...files(templates)]
const sourceHashes = () =>
	Object.fromEntries(ownedSources.map((path) => [relative(root, path), hash(readFileSync(path))]))
const before = sourceHashes()
const identity = {
	source: registry ?? 'existing-local-build',
	tarball,
	sha256: hash(readFileSync(tarball)),
	fixtureSources: before,
}
writeFileSync(join(proof, 'package-identity.json'), JSON.stringify(identity, null, 2))
async function availablePort(requested = 0) {
	const server = createServer()
	await new Promise((resolveListen, reject) => {
		server.once('error', reject)
		server.listen(requested, '127.0.0.1', resolveListen)
	})
	const address = server.address()
	assert.ok(address && Object(address) === address)
	const port = address.port
	await new Promise((resolveClose, reject) =>
		server.close((error) => (error ? reject(error) : resolveClose())),
	)
	return port
}
for (const [label, installer, helpers, zod] of [
	['installed', 'bun', manifest.devDependencies['convex-helpers'], manifest.devDependencies.zod],
	['minimum', 'npm', '0.1.127', '4.5.4'],
]) {
	const fixture = join(proof, label)
	mkdirSync(fixture)
	for (const source of files(templates)) {
		const destination = join(fixture, relative(templates, source).replace(/\.template$/, ''))
		mkdirSync(dirname(destination), { recursive: true })
		cpSync(source, destination)
	}
	cpSync(join(root, 'scripts/convex-smoke-env.mjs'), join(fixture, 'convex-smoke-env.mjs'))
	writeFileSync(
		join(fixture, 'package.json'),
		JSON.stringify(
			{
				private: true,
				type: 'module',
				dependencies: {
					'cvx-kit': `file:${tarball}`,
					convex: '1.46.0',
					'convex-helpers': helpers,
					zod,
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
					strict: true,
					skipLibCheck: false,
					noEmit: true,
					target: 'ES2025',
					lib: ['ES2025', 'DOM'],
					module: 'ESNext',
					moduleResolution: 'bundler',
					types: ['node'],
				},
				include: ['convex/**/*.ts', 'types.ts'],
			},
			null,
			2,
		),
	)
	run(installer, ['install', '--ignore-scripts'], fixture, `${label}-install`)
	const versions = Object.fromEntries(
		['cvx-kit', 'convex', 'convex-helpers', 'zod', 'typescript'].map((name) => [
			name,
			JSON.parse(readFileSync(join(fixture, 'node_modules', name, 'package.json'), 'utf8')).version,
		]),
	)
	assert.equal(versions['cvx-kit'], registry ? registry.slice('cvx-kit@'.length) : manifest.version)
	writeFileSync(join(fixture, 'versions.json'), JSON.stringify(versions, null, 2))
	assertIsolatedConvexFixture(fixture)
	const cloud = await availablePort()
	let site = await availablePort()
	while (site === cloud) site = await availablePort()
	const pids = []
	let failure
	const secrets = new Set()
	const rememberSecrets = () => {
		const path = join(fixture, '.convex/local/default/config.json')
		if (existsSync(path)) {
			const config = JSON.parse(readFileSync(path, 'utf8'))
			if (config.adminKey) secrets.add(config.adminKey)
		}
	}
	const redact = (value) => {
		rememberSecrets()
		for (const secret of secrets) value = value.replaceAll(secret, '[REDACTED_LOCAL_KEY]')
		return value.replace(/(Authorization:\s*(?:Convex|Bearer)\s+)\S+/gi, '$1[REDACTED]')
	}
	async function native(phase, cliArgs) {
		const result = await runOwnedProcess({
			command: process.execPath,
			args: [join(fixture, 'node_modules/convex/bin/main.js'), ...cliArgs],
			cwd: fixture,
			env: environment,
			timeoutMs: 180000,
			onSpawn: (pid) => pids.push(pid),
		})
		const { stdout, stderr, ...lifecycle } = result
		writeFileSync(join(fixture, `${phase}.log`), redact(stdout + stderr))
		writeFileSync(join(fixture, `${phase}-process.json`), JSON.stringify(lifecycle, null, 2))
		assert.equal(result.code, 0, `${label}/${phase} failed; see retained proof`)
		assert.equal(result.timedOut, false, `${label}/${phase} exceeded bounded integration deadline`)
		assert.equal(result.cleanup?.alive, false, `${label}/${phase} owned group survived cleanup`)
		// Convex dev --start can exit zero even when its child verifier fails.
		// Runtime acceptance is reported only after checking the verifier's evidence.
		if (phase !== 'runtime') console.log(`${label}/${phase}: passed`)
	}
	try {
		await native('deploy', [
			'dev',
			'--once',
			'--typecheck=disable',
			'--local-cloud-port',
			String(cloud),
			'--local-site-port',
			String(site),
		])
		assertLocalConvexState(fixture)
		const config = JSON.parse(
			readFileSync(join(fixture, '.convex/local/default/config.json'), 'utf8'),
		)
		assert.equal(config.ports.cloud, cloud)
		assert.equal(config.ports.site, site)
		writeFileSync(
			join(fixture, 'local-binding.json'),
			JSON.stringify({ ports: config.ports, backendVersion: config.backendVersion }, null, 2),
		)
		// Sanctioned codegen only: never write substitute _generated modules.
		await native('codegen', ['codegen', '--typecheck=disable'])
		assert.ok(existsSync(join(fixture, 'convex/_generated/dataModel.d.ts')))
		run(
			join(fixture, 'node_modules/.bin/tsc'),
			['--project', 'tsconfig.json'],
			fixture,
			`${label}-types`,
		)
		writeFileSync(
			join(fixture, 'strict-types.json'),
			JSON.stringify({ strict: true, skipLibCheck: false, exitCode: 0 }),
		)
		await native('runtime', [
			'dev',
			'--once',
			'--typecheck=disable',
			'--start',
			`node verify.mjs ${cloud}`,
		])
		assert.ok(
			existsSync(join(fixture, 'NATIVE_SUCCESS')),
			`${label}: native verifier failed or did not finish; see ${join(fixture, 'runtime.log')}`,
		)
		const results = JSON.parse(readFileSync(join(fixture, 'native-results.json'), 'utf8'))
		assert.ok(results.length >= 40)
		assert.ok(results.every((result) => result.passed === true))
		assert.equal(
			new Set(results.map((result) => result.label)).size,
			results.length,
			'Native assertion labels must be unique',
		)
		assert.equal(
			readFileSync(join(fixture, 'NATIVE_SUCCESS'), 'utf8'),
			`${results.length} native assertions passed\n`,
		)
		console.log(`${label}/runtime: passed (${results.length} native assertions)`)
	} catch (error) {
		failure = error
		throw error
	} finally {
		rememberSecrets()
		const cleanup = await collectOwnedCleanup({
			pids,
			ports: [cloud, site],
			checkPort: availablePort,
			failure,
		})
		writeFileSync(join(fixture, 'cleanup.json'), JSON.stringify(cleanup, null, 2))
		// Keep generated contracts, versions, assertions and lifecycle proof; remove local admin credentials/state.
		rmSync(join(fixture, '.convex'), { recursive: true, force: true })
		rmSync(join(fixture, '.env.local'), { force: true })
		for (const path of files(fixture, true).filter((path) => /\.(json|log)$/.test(path))) {
			const contents = readFileSync(path, 'utf8')
			for (const secret of secrets)
				assert.ok(!contents.includes(secret), 'Local credential escaped evidence redaction')
		}
		if (!failure) {
			assert.ok(
				cleanup.groups.every((group) => !group.alive && !group.error && group.errors.length === 0),
				'Owned process cleanup failed',
			)
			assert.ok(
				cleanup.ports.every((port) => port.closed),
				'Native fixture ports remain occupied',
			)
		}
	}
}
assert.deepEqual(sourceHashes(), before, 'Owned fixture sources changed during proof')
assert.equal(hash(readFileSync(tarball)), identity.sha256)
writeFileSync(
	join(proof, 'SUCCESS'),
	'Both strict installed peer matrices and native shared-engine flows passed.\n',
)
console.log(`Variant shared-engine proof complete: ${proof}`)
