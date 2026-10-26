import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
	cpSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
	existsSync,
} from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { runOwnedProcess } from './owned-process.mjs'

// Explicit prebuilt artifact and owned disposable directory: never build a caller's checkout.
const [
	artifactArg,
	evidenceArg,
	binaryArg,
	tuple = 'current',
	mode = 'candidate',
	baselineEvidence,
] = process.argv.slice(2)
assert.ok(
	artifactArg && evidenceArg && binaryArg,
	'Usage: node test-packed-compact-pagination.mjs artifact.tgz /tmp/owned-evidence backend [current|minimum] [candidate|baseline]',
)
assert.ok(['current', 'minimum'].includes(tuple))
assert.ok(['candidate', 'baseline'].includes(mode))
const root = realpathSync(resolve(import.meta.dirname, '..'))
const evidence = resolve(evidenceArg),
	artifact = realpathSync(artifactArg),
	binary = realpathSync(binaryArg)
assert.ok(
	root.startsWith('/private/tmp/') || root.startsWith('/tmp/'),
	'Run the script from an isolated /tmp snapshot',
)
assert.ok(evidence.startsWith('/tmp/') || evidence.startsWith('/private/tmp/'))
assert.equal(
	existsSync(evidence),
	false,
	'Use a fresh evidence directory; retain every prior attempt',
)
for (let directory = root; ; directory = dirname(directory)) {
	assert.equal(
		readdirSync(directory).some((n) => /^\.env(?:\.|$)/.test(n)),
		false,
		'Environment filename in snapshot ancestry',
	)
	if (dirname(directory) === directory) break
}
mkdirSync(evidence, { recursive: true })
const app = join(evidence, 'app')
mkdirSync(app)
for (const name of ['home', 'tmp']) mkdirSync(join(evidence, name))
const env = {
	PATH: '/opt/homebrew/bin:/usr/bin:/bin',
	HOME: join(evidence, 'home'),
	TMPDIR: join(evidence, 'tmp'),
	CI: '1',
}
const versions =
	tuple === 'current' ? ['1.48.0', '0.1.129', '4.6.5'] : ['1.46.0', '0.1.127', '4.5.4']
const hash = (b) => createHash('sha256').update(b).digest('hex')
const json = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2))
const measurements = {},
	commands = []
let secret = '',
	admin = '',
	backend,
	backendOutput = '',
	failure
const redact = (s) =>
	[secret, admin].filter(Boolean).reduce((s, key) => s.replaceAll(key, '[REDACTED]'), s)
async function command(label, executable, args, timeoutMs = 180000) {
	const r = await runOwnedProcess({ command: executable, args, cwd: app, env, timeoutMs })
	writeFileSync(join(evidence, label + '.stdout.log'), redact(r.stdout))
	writeFileSync(join(evidence, label + '.stderr.log'), redact(r.stderr))
	const { stdout: _stdout, stderr: _stderr, ...receipt } = r
	commands.push({ label, executable, args: args.map(redact), cwd: app, env, ...receipt })
	json('commands.json', commands)
	assert.equal(r.code, 0, label + ' failed; inspect retained logs')
	assert.equal(r.timedOut, false, label + ' timed out')
	assert.equal(r.cleanup?.alive, false, label + ' left a child process group')
	return r.stdout
}
async function port(requested = 0) {
	const s = createServer()
	await new Promise((r, j) => {
		s.once('error', j)
		s.listen(requested, '127.0.0.1', r)
	})
	const p = s.address().port
	await new Promise((r) => s.close(r))
	return p
}
const cloud = await port(),
	site = await port(),
	url = 'http://127.0.0.1:' + cloud
const raw = []
try {
	cpSync(join(root, 'test/fixture-compact-pagination'), app, { recursive: true })
	writeFileSync(
		join(app, 'package.json'),
		JSON.stringify({
			private: true,
			type: 'module',
			dependencies: {
				'cvx-kit': 'file:' + artifact,
				convex: versions[0],
				'convex-helpers': versions[1],
				zod: versions[2],
				typescript: '7.0.2',
				'@types/node': '26.6.5',
				effect: '4.0.2',
			},
		}),
	)
	writeFileSync(
		join(app, 'convex.json'),
		JSON.stringify({ functions: 'convex/', codegen: { staticApi: true, fileType: 'js/dts' } }),
	)
	await command('install', 'bun', ['--no-env-file', 'install', '--ignore-scripts'])
	json('identity.json', {
		artifact,
		artifactSha256: hash(readFileSync(artifact)),
		backend: binary,
		backendSha256: hash(readFileSync(binary)),
		packages: Object.fromEntries(
			['cvx-kit', 'convex', 'convex-helpers', 'zod', 'typescript'].map((n) => [
				n,
				JSON.parse(readFileSync(join(app, 'node_modules', n, 'package.json'))).version,
			]),
		),
		tuple,
		mode,
	})
	secret = randomBytes(32).toString('hex')
	const instance = 'u5-compact-' + tuple
	const key = spawnSync(
		binary,
		['keygen', 'admin-key', '--instance-name', instance, '--instance-secret', secret],
		{ env, encoding: 'utf8', timeout: 10000 },
	)
	assert.equal(key.status, 0, 'Owned key generation failed')
	admin = key.stdout.trim()
	const backendArgs = [
		'--interface',
		'127.0.0.1',
		'--port',
		String(cloud),
		'--site-proxy-port',
		String(site),
		'--instance-name',
		instance,
		'--instance-secret',
		secret,
		'--disable-beacon',
		'--local-storage',
		join(evidence, 'storage'),
		join(evidence, 'backend.sqlite3'),
	]
	backend = spawn(binary, backendArgs, {
		cwd: evidence,
		env,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	backend.stdout.on('data', (b) => (backendOutput += b))
	backend.stderr.on('data', (b) => (backendOutput += b))
	commands.push({
		label: 'backend',
		executable: binary,
		args: backendArgs.map(redact),
		cwd: evidence,
		env,
		pid: backend.pid,
	})
	let ready = false
	for (const deadline = Date.now() + 30000; Date.now() < deadline && backend.exitCode === null;) {
		try {
			const r = await fetch(url + '/version', { signal: AbortSignal.timeout(1000) })
			if (r.ok) {
				writeFileSync(join(evidence, 'backend-version.txt'), await r.text())
				ready = true
				break
			}
		} catch {}
		await delay(100)
	}
	assert.ok(ready, 'Owned backend readiness deadline')
	// Seed before the large full-validator push consumes the local backend's write
	// throughput budget. This is a separate small deployment, not a retry or sleep.
	const functionPath = join(app, 'convex/functions.ts')
	const fullFunctions = readFileSync(functionPath, 'utf8')
	let seededIds
	try {
		writeFileSync(
			functionPath,
			"import { mutation } from './_generated/server'\n" +
				fullFunctions.slice(fullFunctions.indexOf('export const seed =')),
		)
		await command('bootstrap-schema-and-seed', process.execPath, [
			join(app, 'node_modules/convex/bin/main.js'),
			'deploy',
			'--yes',
			'--typecheck=disable',
			'--url',
			url,
			'--admin-key',
			admin,
		])

		const response = await fetch(url + '/api/mutation', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: 'Convex ' + admin },
			body: JSON.stringify({ path: 'functions:seed', format: 'convex_encoded_json', args: [{}] }),
			signal: AbortSignal.timeout(20000),
		})
		const body = await response.json()
		raw.push({
			name: 'seed',
			kind: 'mutation',
			args: {},
			accept: true,
			httpStatus: response.status,
			body,
		})
		assert.equal(body.status, 'success', 'Native bootstrap seed failed: ' + JSON.stringify(body))
		seededIds = body.value
	} finally {
		writeFileSync(functionPath, fullFunctions)
	}
	await command('deploy-static-api', process.execPath, [
		join(app, 'node_modules/convex/bin/main.js'),
		'deploy',
		'--yes',
		'--typecheck=disable',
		'--url',
		url,
		'--admin-key',
		admin,
	])
	const api = readFileSync(join(app, 'convex/_generated/api.d.ts'), 'utf8')
	assert.ok(
		!api.includes('typeof import(') && !api.includes('ApiFromModules'),
		'Expected actual static API declarations',
	)
	writeFileSync(join(evidence, 'api.d.ts'), api)
	const argumentsByFunction = {}
	// Official generator emits literal object arguments. Slice their balanced braces
	// verbatim; do not reconstruct or infer declarations from fixture source.
	const refs =
		/([A-Za-z][A-Za-z0-9_]*): FunctionReference<\s*"(?:query|mutation|action)",\s*"(?:public|internal)",\s*(\{)/g
	for (const match of api.matchAll(refs)) {
		const start = match.index + match[0].length - 1
		let end = start,
			braces = 0
		do {
			if (api[end] === '{') braces++
			if (api[end] === '}') braces--
			end++
		} while (braces && end < api.length)
		assert.equal(braces, 0, 'Unbalanced generated arguments')
		const args = api.slice(start, end)
		argumentsByFunction[match[1]] = {
			bytes: Buffer.byteLength(args),
			lines: args.split('\n').length,
			sha256: hash(args),
		}
		writeFileSync(join(evidence, match[1] + '-args.d.ts.txt'), args)
	}
	assert.ok(
		argumentsByFunction.scalar && argumentsByFunction.relation && argumentsByFunction.idHeavy,
	)
	measurements.api = {
		bytes: Buffer.byteLength(api),
		lines: api.split('\n').length,
		sha256: hash(api),
		argumentsByFunction,
	}
	// Capture real exported native registration JSON from the installed packed consumer.
	writeFileSync(
		join(app, 'capture.ts'),
		`import {writeFileSync} from 'node:fs'; import * as f from './convex/functions'; for(const name of ['scalar','relation','idHeavy','variantIds']) writeFileSync('../'+name+'.json',f[name].exportArgs());`,
	)
	await command('registered-json', 'bun', ['--no-env-file', 'capture.ts'])
	measurements.validators = Object.fromEntries(
		['scalar', 'relation', 'idHeavy', 'variantIds'].map((n) => {
			const b = readFileSync(join(evidence, n + '.json'))
			return [n, { bytes: b.length, lines: b.toString().split('\n').length, sha256: hash(b) }]
		}),
	)
	json('measurements.json', measurements)
	if (mode === 'baseline') {
		// The unchanged base must fail the corrected scalar target for the intended reason.
		try {
			assert.ok(
				measurements.validators.scalar.bytes <= 40 * 1024,
				'scalar registered validator exceeds 40 KiB',
			)
		} catch (e) {
			json('baseline-size-RED.json', {
				intended: true,
				message: e.message,
				bytes: measurements.validators.scalar.bytes,
				ceiling: 40 * 1024,
			})
		}
		assert.ok(
			existsSync(join(evidence, 'baseline-size-RED.json')),
			'Baseline did not produce intended size RED',
		)
		const native = await import(pathToFileURL(join(app, 'runtime.mjs')).href)
		await native.prove({ url, admin, raw, seededIds, baseline: true })
	} else {
		assert.ok(measurements.validators.scalar.bytes <= 40 * 1024)
		if (baselineEvidence) {
			const { compare } = await import(
				pathToFileURL(join(root, 'test/fixture-compact-pagination/compare.mjs')).href
			)
			compare(resolve(baselineEvidence), evidence, join(evidence, 'reduction.json'))
		}
		const native = await import(pathToFileURL(join(app, 'runtime.mjs')).href)
		await native.prove({ url, admin, raw, seededIds })
		writeFileSync(
			join(app, 'types.ts'),
			readFileSync(join(root, 'test/compact-pagination-generated-types.ts'), 'utf8').replaceAll(
				'./fixture-compact-pagination/',
				'./',
			),
		)
		writeFileSync(
			join(app, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					target: 'ES2025',
					module: 'ESNext',
					moduleResolution: 'bundler',
					skipLibCheck: false,
					types: ['node'],
				},
				include: ['types.ts', 'api-only.ts'],
			}),
		)
		await command('generated-types', process.execPath, [
			join(app, 'node_modules/typescript/bin/tsc'),
			'--noEmit',
			'-p',
			'tsconfig.json',
		])
	}
	json('result.json', { status: 'PASS', tuple, mode })
} catch (e) {
	failure = { name: e.name, message: e.message, stack: redact(e.stack ?? '') }
	json('result.json', { status: 'FAIL', tuple, mode, failure })
	process.exitCode = 1
} finally {
	json('runtime.json', raw)
	const cleanup = { backend: null, ports: [], errors: [] }
	if (backend?.pid) {
		const closed = new Promise((r) => {
			if (backend.exitCode !== null || backend.signalCode !== null) r()
			else backend.once('exit', r)
		})
		const signals = []
		for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
			if (backend.exitCode !== null || backend.signalCode !== null) break
			try {
				process.kill(-backend.pid, signal)
				signals.push(signal)
			} catch (e) {
				if (e.code !== 'ESRCH') cleanup.errors.push({ code: e.code, message: e.message })
			}
			await Promise.race([closed, delay(1000)])
		}
		await closed
		let alive = false
		try {
			process.kill(-backend.pid, 0)
			alive = true
		} catch (e) {
			if (e.code !== 'ESRCH') cleanup.errors.push({ code: e.code, message: e.message })
		}
		cleanup.backend = {
			pid: backend.pid,
			signals,
			alive,
			code: backend.exitCode,
			signal: backend.signalCode,
		}
	}
	for (const p of [cloud, site]) {
		try {
			cleanup.ports.push({ port: p, closed: (await port(p)) === p })
		} catch (e) {
			cleanup.ports.push({ port: p, closed: false, error: e.code })
		}
	}
	writeFileSync(join(evidence, 'backend.log'), redact(backendOutput))
	json('commands.json', commands)
	json('cleanup.json', { ...cleanup, failure })
	assert.ok(
		!cleanup.backend?.alive && cleanup.ports.every((p) => p.closed) && cleanup.errors.length === 0,
		'Owned backend cleanup failed',
	)
	console.log(JSON.stringify({ tuple, mode, status: failure ? 'FAIL' : 'PASS', evidence, cleanup }))
}
