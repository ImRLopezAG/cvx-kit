import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
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
async function verifyNativeFixture(script, label, port, environment = {}) {
	const child = spawn(
		'node',
		[
			join(fixture, 'node_modules/convex/bin/main.js'),
			'dev',
			'--once',
			'--typecheck=disable',
			'--start',
			`node ${script} ${port}`,
		],
		{
			cwd: fixture,
			env: { ...localConvexEnvironment(), ...environment },
			stdio: ['pipe', 'pipe', 'pipe'],
		},
	)
	let output = ''
	let diagnostics = ''
	child.stdout.setEncoding('utf8').on('data', (chunk) => {
		output += chunk
	})
	child.stderr.setEncoding('utf8').on('data', (chunk) => {
		diagnostics += chunk
	})
	const deadline = setTimeout(() => child.kill('SIGINT'), 90000)
	try {
		const code = await new Promise((resolve, reject) => {
			child.once('error', reject)
			child.once('close', resolve)
		})
		process.stdout.write(output)
		process.stderr.write(diagnostics)
		assert.equal(code, 0, `Native ${label} command must complete successfully`)
		const marker = environment.WORKFLOW_NATIVE_PHASE
			? `U6 real native deployment phase passed: ${environment.WORKFLOW_NATIVE_PHASE}`
			: `Native ${label} passed:`
		assert.ok(output.includes(marker))
	} finally {
		clearTimeout(deadline)
		child.stdin.end()
	}
}
async function verifyWorkflowDeployments(port) {
	const sourcePath = join(fixture, 'convex/workflowNative.ts')
	const source = readFileSync(sourcePath, 'utf8')
	assert.ok(source.includes("export const deployedBindingVersion = '1'"))
	assert.ok(source.includes("export const deployedArgumentSuffix = ''"))
	const state = join(temporaryRoot, 'workflow-deployment-state.json')
	const phase = (value) =>
		verifyNativeFixture('workflow-proof.mjs', 'workflow proof', port, {
			WORKFLOW_NATIVE_PHASE: value,
			WORKFLOW_NATIVE_PHASE_STATE: state,
		})
	try {
		await phase('prepare')
		writeFileSync(
			sourcePath,
			source.replace(
				"export const deployedBindingVersion = '1'",
				"export const deployedBindingVersion = '2'",
			),
		)
		await phase('compatible')
		writeFileSync(
			sourcePath,
			source.replace(
				"export const deployedArgumentSuffix = ''",
				"export const deployedArgumentSuffix = '-changed'",
			),
		)
		await phase('changed-args')
	} finally {
		writeFileSync(sourcePath, source)
		convex('dev', '--once', '--typecheck=disable')
	}
}
function invoke(name, args = {}, identity) {
	const output = convex(
		'run',
		name.includes(':') ? name : `functions:${name}`,
		JSON.stringify(args),
		...(identity ? ['--identity', JSON.stringify(identity)] : []),
	)
	// Convex 1.45's run command emits no output for a successful null result.
	return output.trim() === '' ? null : JSON.parse(output)
}
function rejection(name, args, expected, identity) {
	assert.throws(
		() => invoke(name, args, identity),
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
					'@convex-dev/workflow': manifest.dependencies['@convex-dev/workflow'],
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
	cpSync(join(root, 'test/fixture-effect/pagination.mjs'), join(fixture, 'pagination.mjs'))
	cpSync(join(root, 'test/fixture-effect/idempotency.mjs'), join(fixture, 'idempotency.mjs'))
	cpSync(join(root, 'test/fixture-effect/async-domain.mjs'), join(fixture, 'async-domain.mjs'))
	cpSync(
		join(root, 'test/fixture-effect/action-validation.mjs'),
		join(fixture, 'action-validation.mjs'),
	)
	cpSync(
		join(root, 'test/fixture-effect/integrated-rename.mjs'),
		join(fixture, 'integrated-rename.mjs'),
	)
	cpSync(
		join(root, 'test/fixture-effect/deployment-versions.mjs'),
		join(fixture, 'deployment-versions.mjs'),
	)
	cpSync(join(root, 'scripts/convex-smoke-env.mjs'), join(fixture, 'convex-smoke-env.mjs'))
	cpSync(join(root, 'test/fixture-effect/workflow-proof.mjs'), join(fixture, 'workflow-proof.mjs'))
	cpSync(
		join(root, 'test/fixture-effect/operation-tools.mjs'),
		join(fixture, 'operation-tools.mjs'),
	)
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
	// Keep the local backend alive for the subscription; one-off CLI calls stop it on exit.
	await verifyNativeFixture('pagination.mjs', 'pagination', cloudPort)
	await verifyNativeFixture('idempotency.mjs', 'idempotency', cloudPort)
	const versionProof = run('node', ['deployment-versions.mjs', String(cloudPort)])
	assert.ok(versionProof.includes('Native deployment versions passed:'))
	process.stdout.write(versionProof)
	await verifyNativeFixture('workflow-proof.mjs', 'workflow proof', cloudPort)
	await verifyWorkflowDeployments(cloudPort)
	await verifyNativeFixture('operation-tools.mjs', 'operation tools', cloudPort)
	await verifyNativeFixture('async-domain.mjs', 'async domain', cloudPort)
	await verifyNativeFixture('action-validation.mjs', 'action validation', cloudPort)
	await verifyNativeFixture('integrated-rename.mjs', 'integrated rename', cloudPort)
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
	assert.deepEqual(invoke('read', { key: 'provider-initialization' }), [])
	for (let invocation = 0; invocation < 2; invocation++) {
		assert.throws(
			() => invoke('providerInitializationFailure'),
			(error) => {
				const message = String(error.stderr)
				assert.match(message, /FIXTURE_PROVIDER_INITIALIZATION/)
				assert.match(
					message,
					/"events"\s*:\s*\[\s*"acquire"\s*,\s*"initialize"\s*,\s*"release"\s*\]/,
				)
				assert.doesNotMatch(message, /"handler"|FIXTURE_PROVIDER_UNEXPECTED/)
				return true
			},
		)
		assert.deepEqual(
			invoke('read', { key: 'provider-initialization' }),
			[],
			'Provider acquisition and awaited release writes must roll back after initialization fails',
		)
	}
	assert.deepEqual(invoke('actions:orchestrate', { key: 'action' }), {
		body: 'fixture-http-ok',
		stages: ['domain', 'audit', 'completion'],
		rejected: true,
	})
	assert.deepEqual(
		invoke('actions:declaredFailureRoundTrip', { key: 'declared-round-trip', composite: false }),
		{
			kind: 'declared',
			code: 'DENIED',
			key: 'declared-round-trip',
		},
	)
	assert.deepEqual(invoke('read', { key: 'declared-round-trip' }), [])
	assert.deepEqual(
		invoke('actions:declaredFailureRoundTrip', { key: 'composite-round-trip', composite: true }),
		{ kind: 'unknown' },
	)
	assert.deepEqual(invoke('read', { key: 'composite-round-trip' }), [])
	const crudOwner = { subject: 'crud-owner', org_id: 'tenant-a', role: 'owner' }
	const otherId = invoke('crud:createOther', {}, crudOwner)
	const initialOtherState = invoke('crud:otherState', { id: otherId })
	assert.deepEqual(initialOtherState, { title: 'other-table', audits: [] })
	for (const [operation, input] of [
		['crud:getFromString', { id: otherId }],
		['crud:updateFromString', { id: otherId, data: { title: 'wrong-table-write' } }],
		['crud:archiveFromString', { id: otherId }],
	]) {
		rejection(operation, input, /Invalid ID for table "crudNotes"/, crudOwner)
		assert.deepEqual(invoke('crud:otherState', { id: otherId }), initialOtherState)
	}
	const created = invoke('crud:create', { title: 'native-crud' }, crudOwner)
	assert.match(created.id, /^.+$/)
	assert.deepEqual(invoke('crud:get', { id: created.id }, crudOwner), { title: 'native-crud' })
	const initialCrudState = invoke('crud:state', { id: created.id })
	assert.deepEqual(initialCrudState, {
		note: {
			title: 'native-crud',
			tenant: 'tenant-a',
			owner: 'crud-owner',
			secret: 'server-private',
		},
		history: ['insert'],
		audits: [{ operation: 'crudNotes.create', actor: 'crud-owner' }],
	})
	rejection('crud:get', { id: created.id }, /UNAUTHENTICATED|authenticated/i)
	rejection(
		'crud:update',
		{ id: created.id, data: { title: 'viewer-write' } },
		/access|allow|permission/i,
		{ ...crudOwner, subject: 'crud-viewer', role: 'viewer' },
	)
	rejection(
		'crud:update',
		{ id: created.id, data: { tenant: 'tenant-b', secret: 'caller-secret' } },
		/validation|invalid|unrecognized|extra/i,
		crudOwner,
	)
	const foreignOwner = { ...crudOwner, subject: 'foreign-owner', org_id: 'tenant-b' }
	assert.equal(invoke('crud:get', { id: created.id }, foreignOwner), null)
	assert.deepEqual(invoke('crud:list', { numItems: 2, cursor: null }, foreignOwner).page, [])
	assert.deepEqual(invoke('crud:list', { numItems: 2, cursor: null }, crudOwner).page, [
		{ title: 'native-crud' },
	])
	rejection('crud:list', { numItems: 3, cursor: null }, /validation|invalid|too big/i, crudOwner)
	rejection(
		'crud:update',
		{ id: created.id, data: { title: 'foreign' } },
		/access|exist/i,
		foreignOwner,
	)
	rejection(
		'crud:update',
		{ id: created.id, data: { title: 'audit-rollback' }, failAudit: true },
		/CRUD_AUDIT_FAILURE/,
		crudOwner,
	)
	rejection('crud:invalidOutput', { id: created.id }, /invalid|expected|validation/i, crudOwner)
	assert.deepEqual(
		invoke('crud:state', { id: created.id }),
		initialCrudState,
		'RLS, audit and native output failures must leave business, trigger and audit rows unchanged',
	)
	assert.deepEqual(
		invoke('crud:update', { id: created.id, data: { title: 'native-updated' } }, crudOwner),
		{ ok: true },
	)
	assert.deepEqual(invoke('crud:get', { id: created.id }, crudOwner), { title: 'native-updated' })
	const updatedCrudState = invoke('crud:state', { id: created.id })
	assert.deepEqual(updatedCrudState.note, { ...initialCrudState.note, title: 'native-updated' })
	assert.deepEqual(updatedCrudState.history, ['insert', 'update'])
	assert.deepEqual(updatedCrudState.audits, [
		...initialCrudState.audits,
		{ operation: 'crudNotes.update', actor: 'crud-owner' },
	])
	assert.deepEqual(invoke('crud:update', { id: created.id, data: {} }, crudOwner), { ok: true })
	for (let attempt = 0; attempt < 2; attempt++) {
		assert.deepEqual(invoke('crud:archive', { id: created.id }, crudOwner), { ok: true })
	}
	const archivedCrudState = invoke('crud:state', { id: created.id })
	assert.equal(archivedCrudState.note.title, 'native-updated')
	assert.ok(Number.isFinite(archivedCrudState.note.archivedAt))
	assert.deepEqual(archivedCrudState.history, ['insert', 'update', 'update', 'update', 'update'])
	assert.deepEqual(
		archivedCrudState.audits.map((entry) => entry.operation),
		[
			'crudNotes.create',
			'crudNotes.update',
			'crudNotes.update',
			'crudNotes.archive',
			'crudNotes.archive',
		],
	)
	assert.ok(archivedCrudState.audits.every((entry) => entry.actor === 'crud-owner'))
	console.log(
		'Actual local runtime passed: async query ordinary/gen/fn composition, spans, awaited scoped release, domain/audit/completion rollback, declared ConvexError.data round-trip, composite safe unknown round-trip, projected rejection, cleanup/composite rejection, HTTP action and separate transaction commits, secured CRUD tenant projection/pagination, nonempty/empty update persistence, repeated archive, and business/trigger/audit rollback',
	)
} catch (error) {
	if (error.stdout) process.stderr.write(String(error.stdout))
	if (error.stderr) process.stderr.write(String(error.stderr))
	throw error
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true })
}
