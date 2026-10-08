import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ConvexHttpClient } from 'convex/browser'
import { api, internal } from './convex/_generated/api.js'

const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
const port = Number(process.argv[2])
assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536)
const owner = {
	issuer: 'https://idempotency.test.invalid',
	subject: 'idem-owner',
	org_id: 'idem-tenant',
	role: 'owner',
}
function connection(identity = owner) {
	const client = new ConvexHttpClient(`http://127.0.0.1:${port}`)
	client.setAdminAuth(config.adminKey, identity)
	return client
}
const client = connection()
const state = (key, identity = owner) =>
	client.query(internal.idempotency.state, {
		key,
		tenant: identity.org_id,
		principal: identity.subject,
	})
const save = (key, title, options = {}, caller = client) =>
	caller.mutation(api.idempotency.save, {
		key,
		payload: { title },
		...options,
	})
async function rejectedWithoutWrites(key, title, options, expected) {
	const before = await state(key)
	await assert.rejects(save(key, title, options), expected)
	assert.deepEqual(
		await state(key),
		before,
		'Rejected mutation must preserve receipt, business and audit state',
	)
}
async function verify() {
	const key = 'concurrent'
	const before = await state(key)
	// Both HTTP mutations launch before either is awaited. A synchronous CLI wrapper would serialize them.
	const first = save(key, ' RAW ')
	const second = save(key, ' RAW ', {}, connection())
	const outcomes = await Promise.allSettled([first, second])
	assert.ok(
		outcomes.every((outcome) => outcome.status === 'fulfilled'),
		'Both concurrent calls must succeed',
	)
	const [a, b] = outcomes.map((outcome) => outcome.value)
	assert.deepEqual(a, b)
	assert.equal(a.title, 'raw!')
	const completed = await state(key)
	assert.equal(completed.business.length - before.business.length, 1)
	assert.equal(completed.audits.length - before.audits.length, 1)
	assert.equal(completed.receipts.length - before.receipts.length, 1)
	assert.equal(completed.receipts[0].state, 'completed')
	assert.deepEqual(await save(key, ' RAW '), a, 'Replay must not repeat the fresh title transform')
	assert.deepEqual(await state(key), completed)
	await rejectedWithoutWrites(key, 'raw', {}, /conflict/i)
	for (const version of ['operation', 'contract', 'binding', 'fingerprintPolicy']) {
		await client.mutation(internal.idempotency.alterReceipt, { key, version })
		await rejectedWithoutWrites(key, ' RAW ', {}, /stale/i)
		await rejectedWithoutWrites(key, 'different', {}, /stale/i)
		await client.mutation(internal.idempotency.alterReceipt, { key, restore: true })
	}
	await client.mutation(internal.idempotency.authorize, { allowed: false })
	await rejectedWithoutWrites(key, ' RAW ', {}, /IDEMPOTENCY_DENIED/)
	await client.mutation(internal.idempotency.authorize, { allowed: true })
	assert.deepEqual(await save(key, ' RAW '), a)
	for (const mode of ['audit', 'completion', 'result', 'cleanup']) {
		await rejectedWithoutWrites(
			`rollback-${mode}`,
			'write-before-failure',
			{ mode },
			new RegExp(`IDEMPOTENCY_${mode.toUpperCase()}`),
		)
	}
	for (const corruption of ['result', 'duplicate', 'pending']) {
		const corruptKey = `corrupt-${corruption}`
		await save(corruptKey, 'before')
		await client.mutation(internal.idempotency.alterReceipt, { key: corruptKey, corruption })
		await rejectedWithoutWrites(
			corruptKey,
			'before',
			{},
			corruption === 'duplicate'
				? /ambiguous/i
				: corruption === 'pending'
					? /pending/i
					: /IDEMPOTENCY_WIRE/,
		)
	}
	const another = { ...owner, org_id: 'another-tenant' }
	const principal = { ...owner, subject: 'another-principal' }
	for (const identity of [another, principal]) {
		const isolated = await save(key, 'isolated', {}, connection(identity))
		assert.notEqual(isolated.id, a.id)
		assert.equal((await state(key, identity)).business.length, 1)
	}
	const retained = await state(key)
	await client.mutation(internal.idempotency.alterReceipt, { key, expire: true })
	const fresh = await save(key, 'new-window')
	assert.notEqual(fresh.id, a.id)
	const afterExpiry = await state(key)
	assert.equal(afterExpiry.business.length, retained.business.length + 1)
	assert.equal(afterExpiry.audits.length, retained.audits.length + 1)
	assert.equal(afterExpiry.receipts.length, 1)
	const normalized = await save('normalized', ' NORMAL ', { normalized: true })
	assert.deepEqual(await save('normalized', 'normal', { normalized: true }), normalized)
	await assert.rejects(client.action(api.idempotency.unsupported, {}), /unsupported-binding/i)
	console.log(
		'Native idempotency passed: concurrent equal-key execution, final-wire replay, raw conflict, four stale versions before conflict, revoked authorization, scoped rollback, corruption, scope isolation and host retention',
	)
}
let deadline
try {
	await Promise.race([
		verify(),
		new Promise((_, reject) => {
			deadline = setTimeout(
				() => reject(new Error('Native idempotency verification timed out')),
				60000,
			)
		}),
	])
} finally {
	clearTimeout(deadline)
}
