import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { ConvexHttpClient } from 'convex/browser'
import { internal } from './convex/_generated/api.js'

const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
const port = Number(process.argv[2])
assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536)
const client = new ConvexHttpClient(`http://127.0.0.1:${port}`)
client.setAdminAuth(config.adminKey)

async function terminal(workflowId, key) {
	const deadline = Date.now() + 30000
	while (Date.now() < deadline) {
		const state = await client.query(internal.workflowProof.inspect, { workflowId, key })
		if (state.status.type !== 'inProgress') return state
		await delay(100)
	}
	throw new Error('Native workflow proof timed out')
}

for (const rejectOuter of process.env.WORKFLOW_NATIVE_PHASE ? [] : [false, true]) {
	const key = `${Date.now()}-${rejectOuter ? 'workflow-proof-outer-reject' : 'workflow-proof-terminal'}`
	const workflowId = await client.mutation(internal.workflowProof.start, { key, rejectOuter })
	const state = await terminal(workflowId, key)
	assert.equal(state.steps.page.length, 1)
	const journal = state.steps.page[0]
	assert.equal(journal.name, 'terminal-native-subtransaction')
	assert.equal(state.steps.isDone, true)
	if (rejectOuter) {
		assert.equal(state.status.type, 'failed')
		assert.equal(journal.runResult.kind, 'failed')
		assert.match(journal.runResult.error, /WORKFLOW_OUTER_ROLLBACK/)
		assert.deepEqual(state.writes, [], 'Rejected outer mutation must also roll back its writes')
	} else {
		const safe = { version: 1, code: 'DENIED', key }
		assert.deepEqual(state.status, { type: 'completed', result: safe })
		assert.deepEqual(journal.runResult, { kind: 'success', returnValue: safe })
		assert.deepEqual(state.writes, ['outer-terminal'])
		assert.doesNotMatch(JSON.stringify(safe), /DeclaredError|PRIVATE|stack|declared-domain/)
	}
	assert.ok(!state.writes.includes('declared-domain'), 'Inner rejected mutation must roll back')
}
if (!process.env.WORKFLOW_NATIVE_PHASE)
	console.log(
		'Native workflow proof passed: rejected inner mutation rollback, successful safe terminal envelope journaling, outer rejection rollback and native failed journal',
	)

// All cases below execute registered functions against the pinned real component.
const prefix = `u6-${Date.now()}`
async function inspect(key) {
	return client.query(internal.workflowNative.inspectRun, { key })
}
async function waitFor(key, predicate, label) {
	const deadline = Date.now() + 45000
	while (Date.now() < deadline) {
		const state = await inspect(key)
		if (predicate(state)) return state
		await delay(100)
	}
	throw new Error(`Native workflow ${label} timed out: ${JSON.stringify(await inspect(key))}`)
}
async function launch(mode, options = {}) {
	const key = `${prefix}-${mode}-${options.retry ? 'retry' : 'default'}-${options.callbackFails ? 'callback-fail' : 'callback-ok'}`
	await client.mutation(internal.workflowNative.start, { key, mode, ...options })
	return key
}
async function control(key, operation, generation) {
	const args = { key, operation }
	if (generation !== undefined) args.generation = generation
	return client.mutation(internal.workflowNative.control, args)
}
async function finished(key) {
	return waitFor(key, (state) => state.status.type !== 'inProgress', 'terminal status')
}
async function hostTerminal(key) {
	return waitFor(key, (state) => state.run.state.status !== 'running', 'host callback')
}
function exactlyOneCommit(state, occurrence = 0) {
	assert.equal(state.counts[occurrence].business, 1)
	assert.equal(state.counts[occurrence].audits, 1)
	assert.equal(state.counts[occurrence].receipts.length, 1)
	assert.equal(state.counts[occurrence].receipts[0].state, 'completed')
}

// Packed smoke orchestrates real redeploys between these phases. No component state is reset.
const deploymentPhase = process.env.WORKFLOW_NATIVE_PHASE
const phaseStatePath = process.env.WORKFLOW_NATIVE_PHASE_STATE
if (deploymentPhase) {
	assert.ok(phaseStatePath, 'Deployment phases require a durable host state file')
	if (deploymentPhase === 'prepare') {
		const compatible = `${prefix}-deployment-compatible`
		const changedArgs = `${prefix}-deployment-changed-args`
		for (const key of [compatible, changedArgs]) {
			await client.mutation(internal.workflowNative.start, { key, mode: 'paused' })
			await waitFor(
				key,
				(state) => state.steps.page.some((step) => step.name === 'continue'),
				'deployment paused event',
			)
		}
		writeFileSync(phaseStatePath, JSON.stringify({ compatible, changedArgs }))
	} else {
		const keys = JSON.parse(readFileSync(phaseStatePath, 'utf8'))
		const key = deploymentPhase === 'compatible' ? keys.compatible : keys.changedArgs
		await control(key, 'resume')
		const state = await finished(key)
		exactlyOneCommit(state, 0)
		if (deploymentPhase === 'compatible') {
			assert.equal(state.status.type, 'completed')
			exactlyOneCommit(state, 1)
			assert.deepEqual(state.writes, ['service:first', 'service:second'])
		} else {
			assert.equal(deploymentPhase, 'changed-args')
			assert.equal(state.status.type, 'failed')
			assert.match(state.status.error, /argument|journal|mismatch|match/i)
			assert.equal(state.counts[1].business, 0)
			assert.deepEqual(state.writes, ['service:first'])
		}
	}
	console.log(`U6 real native deployment phase passed: ${deploymentPhase}`)
	process.exit(0)
}

const resumed = await launch('paused')
let state = await waitFor(
	resumed,
	(state) => state.steps.page.some((step) => step.name === 'continue'),
	'paused event',
)
exactlyOneCommit(state)
assert.deepEqual(state.writes, ['service:first'])
await control(resumed, 'resume')
state = await hostTerminal(resumed)
assert.equal(state.status.type, 'completed')
assert.equal(state.run.state.status, 'succeeded')
assert.deepEqual(
	state.writes,
	['service:first', 'service:second'],
	'Journal replay must skip service reconstruction for completed steps',
)
exactlyOneCommit(state, 0)
exactlyOneCommit(state, 1)

const revoked = `${prefix}-revoked`
await client.mutation(internal.workflowNative.start, { key: revoked, mode: 'paused' })
await waitFor(
	revoked,
	(state) => state.steps.page.some((step) => step.name === 'continue'),
	'revoke paused',
)
await control(revoked, 'revoke')
await control(revoked, 'resume')
state = await finished(revoked)
assert.equal(state.status.type, 'failed')
assert.deepEqual(state.writes, ['service:first'])
exactlyOneCommit(state)
assert.equal(state.counts[1].business, 0)
await assert.rejects(control(revoked, 'reconcile'), /WORKFLOW_STATUS_DENIED/)
await control(revoked, 'grant')
await control(revoked, 'reconcile')
assert.equal((await inspect(revoked)).run.state.status, 'failed')

const terminalKey = await launch('terminal')
state = await hostTerminal(terminalKey)
assert.equal(state.status.type, 'completed')
assert.equal(
	state.run.state.status,
	'failed',
	'Safe terminal domain envelope must map native success to failed host status',
)
assert.equal(state.run.state.nativeStatus, 'succeeded')
assert.deepEqual(state.status.result, {
	version: 1,
	kind: 'failed',
	error: { code: 'DENIED', key: terminalKey },
})
assert.deepEqual(state.writes, [])
assert.equal(state.steps.page.length, 1)
assert.doesNotMatch(JSON.stringify(state.status.result), /PRIVATE|stack|DeclaredError/)

const transient = await launch('transient')
state = await hostTerminal(transient)
assert.equal(state.status.type, 'failed')
assert.equal(state.run.attempts, 3, 'Opted-in native action must exhaust exactly three attempts')
assert.equal(state.counts[0].business, 0)

for (const retry of [false, true]) {
	const key = await launch('postcommit', { retry })
	state = await hostTerminal(key)
	exactlyOneCommit(state)
	assert.equal(
		state.run.attempts,
		retry ? 2 : 1,
		'Default retry must remain off even with manager retry defaults enabled',
	)
	assert.equal(state.status.type, retry ? 'completed' : 'failed')
	await control(key, 'reconcile')
	state = await inspect(key)
	assert.equal(state.run.state.status, retry ? 'succeeded' : 'failed')
	assert.equal(state.run.state.nativeStatus, retry ? 'succeeded' : 'failed')
	assert.equal(
		state.run.state.outcome.kind,
		'succeeded',
		'Authorized receipt reconciliation reports committed operation separately from failed workflow',
	)
	if (!retry) {
		await control(key, 'restart', 0)
		state = await finished(key)
		await control(key, 'reconcile', 1)
		state = await inspect(key)
		assert.equal(state.run.state.generation, 1)
		assert.equal(state.run.attempts, 2)
		assert.equal(state.run.state.status, 'succeeded')
		exactlyOneCommit(state)
		assert.equal(
			state.counts[0].key,
			JSON.stringify([key, 'first']),
			'Recovery generation must not alter business receipt identity',
		)
	}
}

const callback = await launch('loop', { callbackFails: true })
state = await finished(callback)
assert.equal(state.status.type, 'completed')
await delay(500)
assert.equal((await inspect(callback)).run.state.status, 'running')
await control(callback, 'repair')
await control(callback, 'reconcile')
state = await inspect(callback)
assert.equal(state.run.state.status, 'succeeded')
exactlyOneCommit(state, 0)
exactlyOneCommit(state, 1)
assert.notEqual(
	state.counts[0].key,
	state.counts[1].key,
	'Loop occurrences must have distinct stable receipt identities',
)

const cancel = await launch('external')
await waitFor(cancel, (state) => state.run.attempts === 1, 'running external action')
await control(cancel, 'cancel')
await control(cancel, 'release')
state = await waitFor(
	cancel,
	(state) => state.writes.includes('external-completed'),
	'late external completion',
)
assert.equal(state.run.state.status, 'canceled')
await control(cancel, 'reconcile')
assert.equal((await inspect(cancel)).run.state.status, 'canceled')
await control(cancel, 'restart', 0)
state = await waitFor(cancel, (state) => state.run.attempts === 2, 'restarted action')
assert.equal(state.run.state.generation, 1)
const late = await client.mutation(internal.workflowNative.deliverLate, {
	key: cancel,
	generation: 0,
})
assert.equal(late.kind, 'ignored')
assert.equal(late.state.generation, 1)
await finished(cancel)
await control(cancel, 'reconcile', 1)
assert.equal((await inspect(cancel)).run.state.status, 'succeeded')

const lostExternal = await launch('external-lost')
await waitFor(lostExternal, (state) => state.run.attempts === 1, 'external response loss attempt')
await control(lostExternal, 'release')
state = await hostTerminal(lostExternal)
assert.equal(state.status.type, 'failed')
assert.equal(state.run.attempts, 1, 'Unknown provider outcome must not cause a blind retry')
assert.deepEqual(state.writes, ['external-completed'])
assert.equal(state.counts[0].receipts.length, 0)
await control(lostExternal, 'reconcile')
state = await inspect(lostExternal)
assert.equal(state.run.state.status, 'failed')
assert.equal(
	state.run.state.outcome,
	undefined,
	'No command receipt or provider reconciliation establishes the unknown provider outcome',
)

const incompatible = await launch('incompatible')
await waitFor(
	incompatible,
	(state) => state.steps.page.some((step) => step.name === 'continue'),
	'incompatible paused',
)
await control(incompatible, 'resume')
state = await finished(incompatible)
assert.equal(state.status.type, 'failed')
assert.match(state.status.error, /Incompatible workflow operation version/)
exactlyOneCommit(state, 0)
assert.equal(state.counts[1].business, 0)
console.log(
	'U6 real native acceptance passed: replay/service reconstruction, revocation/status authorization, safe terminal rollback/host mapping, native retry exhaustion, postcommit no-retry and receipt replay, callback reconciliation, loop identity, cancellation/late completion, restart generation fencing, incompatible version rejection',
)
