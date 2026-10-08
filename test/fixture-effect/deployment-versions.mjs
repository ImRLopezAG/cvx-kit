import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ConvexHttpClient } from 'convex/browser'
import { api, internal } from './convex/_generated/api.js'
import { assertLocalConvexState, localConvexEnvironment } from './convex-smoke-env.mjs'

const baseline = { operation: '1', contract: '1', binding: '1', fingerprintPolicy: 'raw-1' }
const versions = Object.keys(baseline)
const fixture = process.cwd()
const port = Number(process.argv[2])
assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536)
assert.equal(resolve(import.meta.dirname), resolve(fixture))
assert.equal(basename(fixture), 'fixture')
assert.ok(basename(dirname(fixture)).startsWith('cvx-kit-effect-runtime-'))
assertLocalConvexState(fixture)
const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
const owner = {
	issuer: 'https://idempotency.test.invalid',
	subject: 'idem-owner',
	org_id: 'idem-tenant',
	role: 'owner',
}
const client = new ConvexHttpClient(`http://127.0.0.1:${port}`)
client.setAdminAuth(config.adminKey, owner)
const sourcePath = join(fixture, 'convex/idempotencyDeploymentConfig.ts')
const evidencePath = join(fixture, '.deployment-version-receipt.json')
const mode = process.argv[3]
const key = process.argv[4]
const version = process.argv[5]
const state = () =>
	client.query(internal.idempotency.state, {
		key,
		tenant: owner.org_id,
		principal: owner.subject,
	})
const save = (title) => client.mutation(api.idempotency.save, { key, payload: { title } })
const deployed = () => client.query(internal.idempotencyDeploymentConfig.deployedConfiguration, {})

async function probe() {
	assert.match(key, /^deployment-transition-[a-f0-9-]+$/)
	const expected = { ...baseline }
	if (mode === 'stale') {
		assert.ok(versions.includes(version))
		expected[version] = `deployed-${version}-2`
	}
	assert.deepEqual(await deployed(), expected, 'Read back the actual deployed server configuration')
	if (mode === 'seed') {
		await client.mutation(internal.idempotency.authorize, { allowed: true })
		assert.deepEqual(await state(), { business: [], audits: [], receipts: [] })
		const result = await save(' RETAINED ')
		const retained = await state()
		assert.equal(retained.business.length, 1)
		assert.equal(retained.audits.length, 1)
		assert.equal(retained.receipts.length, 1)
		const receipt = retained.receipts[0]
		assert.equal(receipt.operation, 'idempotentNotes.create')
		assert.equal(receipt.scope, JSON.stringify([owner.org_id, owner.subject]))
		assert.equal(receipt.key, key)
		assert.equal(receipt.state, 'completed')
		assert.deepEqual(receipt.versions, baseline)
		writeFileSync(evidencePath, JSON.stringify({ retained, result }))
	} else {
		assert.ok(mode === 'stale' || mode === 'restore')
		const { retained, result } = JSON.parse(readFileSync(evidencePath, 'utf8'))
		assert.deepEqual(
			await state(),
			retained,
			'Redeployment must retain the original receipt verbatim',
		)
		if (mode === 'stale') {
			for (const title of [' RETAINED ', 'changed-payload']) {
				await assert.rejects(save(title), /IDEMPOTENCY_stale/i)
				assert.deepEqual(
					await state(),
					retained,
					`${version}: stale retry must preserve all business, audit and receipt fields`,
				)
			}
		} else {
			assert.deepEqual(await save(' RETAINED '), result)
			await assert.rejects(save('changed-payload'), /IDEMPOTENCY_conflict/i)
			assert.deepEqual(await state(), retained)
		}
	}
	console.log(`Deployed receipt transition verified: ${mode}${version ? ` ${version}` : ''}`)
}

async function coordinate() {
	const original = readFileSync(sourcePath, 'utf8')
	const invocationKey = `deployment-transition-${randomUUID()}`
	const run = promisify(execFile)
	async function deploy(probeMode, field) {
		try {
			const { stdout } = await run(
				process.execPath,
				[
					join(fixture, 'node_modules/convex/bin/main.js'),
					'dev',
					'--once',
					'--typecheck=disable',
					'--start',
					`node deployment-versions.mjs ${port} ${probeMode} ${invocationKey}${field ? ` ${field}` : ''}`,
				],
				{ cwd: fixture, env: localConvexEnvironment(), timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
			)
			assert.ok(stdout.includes(`Deployed receipt transition verified: ${probeMode}`))
			process.stdout.write(stdout)
		} catch (error) {
			// Never print the local config/admin key; CLI diagnostics contain the native rejection.
			if (error.stdout) process.stderr.write(String(error.stdout))
			if (error.stderr) process.stderr.write(String(error.stderr))
			throw error
		}
	}
	let seeded = false
	let failure
	try {
		await deploy('seed')
		seeded = true
		for (const field of versions) {
			const matcher = new RegExp(`^(\\s*${field}: )'${baseline[field]}',`, 'gm')
			assert.equal([...original.matchAll(matcher)].length, 1, `Locate exactly one ${field} config`)
			writeFileSync(sourcePath, original.replace(matcher, `$1'deployed-${field}-2',`))
			await deploy('stale', field)
			writeFileSync(sourcePath, original)
			await deploy('restore')
		}
	} catch (error) {
		failure = error
	} finally {
		writeFileSync(sourcePath, original)
		try {
			// Restore deployed code as well as disk, including after a failed changed-version probe.
			if (seeded) await deploy('restore')
		} catch (restoreError) {
			failure = failure
				? new AggregateError([failure, restoreError], 'Receipt gate failed and restore failed')
				: restoreError
		} finally {
			rmSync(evidencePath, { force: true })
		}
	}
	if (failure) throw failure
	console.log(
		'Native deployment versions passed: four independent server redeployments; same operation/scope/key; identical and changed payload stale before conflict; unchanged retained business/audit/receipt; actual deployed configuration read-back; baseline restored',
	)
}

if (mode) await probe()
else await coordinate()
