import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { ConvexHttpClient } from 'convex/browser'
import { api, internal } from './convex/_generated/api.js'

const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
const port = Number(process.argv[2])
assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536)
const owner = {
	issuer: 'https://integrated-rename.test.invalid',
	subject: 'integrated-owner',
	org_id: 'integrated-tenant',
	role: 'owner',
}
function connection(identity = owner) {
	const client = new ConvexHttpClient(`http://127.0.0.1:${port}`)
	client.setAdminAuth(config.adminKey, identity)
	return client
}
const client = connection()
const unknown = { _tag: 'UnknownFailure', version: 1 }
const state = (id) => client.query(internal.crud.state, { id })
const permission = (allowed) =>
	client.mutation(internal.integratedRename.setAllowed, {
		tenant: owner.org_id,
		actor: owner.subject,
		allowed,
	})
async function waitFor(key, predicate) {
	for (let attempt = 0; attempt < 150; attempt++) {
		const value = await client.query(internal.integratedRename.inspect, { key })
		if (predicate(value)) return value
		await delay(100)
	}
	throw new Error('Integrated rename native workflow did not reach expected state')
}
async function verify() {
	await permission(true)
	const notes = await Promise.all(
		['api', 'tool', 'workflow', 'revoked'].map((title) =>
			client.mutation(api.crud.create, { title }),
		),
	)
	const raw = '  Renamed Title  '
	const expected = { title: 'renamed title!' }
	const before = await Promise.all(notes.map((note) => state(note.id)))
	const direct = await client.mutation(api.integratedRename.rename, {
		id: notes[0].id,
		title: raw,
	})
	assert.deepEqual(direct, expected)
	assert.deepEqual(
		await client.action(api.integratedRename.invokeTool, { id: notes[1].id, title: raw }),
		{ _tag: 'Success', value: direct },
	)
	const key = await client.mutation(api.integratedRename.start, { id: notes[2].id, title: raw })
	await waitFor(key, (value) => value.native === 'inProgress')
	assert.deepEqual(
		await state(notes[2].id),
		before[2],
		'Paused component must not execute rename before its native step',
	)
	await client.mutation(internal.integratedRename.resume, { key })
	assert.deepEqual(await waitFor(key, (value) => value.host === 'succeeded'), {
		host: 'succeeded',
		native: 'completed',
		title: expected.title,
	})
	for (const [index, note] of notes.slice(0, 3).entries()) {
		const saved = await state(note.id)
		assert.deepEqual(saved.note, { ...before[index].note, title: expected.title })
		assert.deepEqual(saved.audits, [
			...before[index].audits,
			{ operation: 'integratedRename.rename', actor: owner.subject },
		])
		assert.deepEqual(saved.history, [...before[index].history, 'update'])
		assert.equal(saved.note.secret, 'server-private')
	}
	assert.deepEqual(Object.keys(direct), ['title'])

	const wrongTable = await client.mutation(api.crud.createOther, {})
	for (const id of ['invalid-convex-id', wrongTable]) {
		await assert.rejects(
			client.mutation(internal.integratedRename.applyRename, {
				execution: {
					version: 1,
					operation: 'integratedRename.rename',
					operationVersion: '1',
					contractVersion: '1',
					bindingVersion: '1',
					run: 'forged',
					capability: 'forged',
					occurrence: 'rename',
					args: { id, title: raw },
				},
			}),
			/ArgumentValidationError/,
		)
	}
	await assert.rejects(
		client.mutation(internal.integratedRename.applyRename, {
			execution: {
				version: 1,
				operation: 'integratedRename.rename',
				operationVersion: '1',
				contractVersion: '1',
				bindingVersion: '1',
				run: 'forged',
				capability: 'forged',
				occurrence: 'rename',
				args: { id: notes[0].id, title: raw },
			},
		}),
		/INTEGRATED_RENAME_AUTHORITY/,
	)
	const committed = await state(notes[0].id)
	for (const field of ['tenant', 'actor']) {
		const forged = { id: notes[0].id, title: 'forged', [field]: 'forged-authority' }
		await assert.rejects(
			client.mutation(api.integratedRename.rename, forged),
			/ArgumentValidationError/,
		)
		assert.deepEqual(await client.action(api.integratedRename.invokeTool, forged), unknown)
		assert.deepEqual(await state(notes[0].id), committed)
	}
	for (const identity of [
		{ ...owner, role: 'viewer' },
		{ ...owner, subject: 'different-owner' },
		{ ...owner, org_id: 'foreign-tenant' },
	]) {
		const denied = connection(identity)
		await assert.rejects(
			denied.mutation(api.integratedRename.rename, { id: notes[0].id, title: 'denied' }),
		)
		assert.deepEqual(
			await denied.action(api.integratedRename.invokeTool, { id: notes[0].id, title: 'denied' }),
			unknown,
		)
		assert.deepEqual(await state(notes[0].id), committed)
	}
	const revokedKey = await client.mutation(api.integratedRename.start, {
		id: notes[3].id,
		title: 'must not persist',
	})
	await waitFor(revokedKey, (value) => value.native === 'inProgress')
	await permission(false)
	try {
		await assert.rejects(
			client.mutation(api.integratedRename.rename, { id: notes[0].id, title: raw }),
			/INTEGRATED_RENAME_DENIED/,
		)
		assert.deepEqual(
			await client.action(api.integratedRename.invokeTool, { id: notes[0].id, title: raw }),
			unknown,
		)
		await client.mutation(internal.integratedRename.resume, { key: revokedKey })
		const deniedWorkflow = await waitFor(revokedKey, (value) => value.host === 'failed')
		assert.equal(deniedWorkflow.native, 'failed')
		assert.equal(deniedWorkflow.title, null)
		assert.deepEqual(
			await state(notes[3].id),
			before[3],
			'New native execution must recheck revoked authority before business, trigger and audit writes',
		)
		assert.deepEqual(await state(notes[0].id), committed)
	} finally {
		await permission(true)
	}
	console.log(
		'Native integrated rename passed: one injected command and registered audited boundary through direct API, selected tool and actual workflow component; raw normalization once, identical public DTO and actor audit, native trigger parity, forged authority rejection, tenant/owner isolation and current revocation without business/audit mutation',
	)
}
let deadline
try {
	await Promise.race([
		verify(),
		new Promise((_, reject) => {
			deadline = setTimeout(() => reject(new Error('Native integrated rename timed out')), 60000)
		}),
	])
} finally {
	clearTimeout(deadline)
}
