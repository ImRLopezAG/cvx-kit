import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ConvexHttpClient } from 'convex/browser'
import { api, internal } from './convex/_generated/api.js'

const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
const port = Number(process.argv[2])
assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536)
const owner = {
	issuer: 'https://operation-tools.test.invalid',
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
const state = (key) =>
	client.query(internal.idempotency.state, {
		key,
		tenant: owner.org_id,
		principal: owner.subject,
	})
const unknown = { _tag: 'UnknownFailure', version: 1 }

async function verify() {
	const key = 'operation-tool-parity'
	const payload = { title: ' TOOL ' }
	const before = await state(key)
	const direct = await client.mutation(api.idempotency.save, { key, payload })
	assert.equal(direct.title, 'tool!')
	const committed = await state(key)
	assert.equal(committed.business.length - before.business.length, 1)
	assert.equal(committed.audits.length - before.audits.length, 1)
	assert.equal(committed.receipts.length - before.receipts.length, 1)
	assert.deepEqual(await client.action(api.operationTools.invoke, { key, payload }), {
		_tag: 'Success',
		value: direct,
	})
	assert.deepEqual(await state(key), committed, 'Tool replay must use the same receipt and audit')
	assert.deepEqual(Object.keys(direct).sort(), ['id', 'title'])
	for (const field of ['tenant', 'actor', 'permission']) {
		const forged = { ...payload, [field]: 'forged' }
		const forgedKey = `operation-tool-forged-${field}`
		const empty = await state(forgedKey)
		assert.deepEqual(empty.business, [])
		assert.deepEqual(empty.audits, [])
		assert.deepEqual(empty.receipts, [])
		await assert.rejects(
			client.mutation(api.idempotency.save, { key: forgedKey, payload: forged }),
			/ArgumentValidationError/,
		)
		assert.deepEqual(
			await client.action(api.operationTools.invoke, { key: forgedKey, payload: forged }),
			unknown,
		)
		assert.deepEqual(await state(forgedKey), empty)
	}
	await client.mutation(internal.idempotency.authorize, { allowed: false })
	try {
		await assert.rejects(
			client.mutation(api.idempotency.save, { key, payload }),
			/IDEMPOTENCY_DENIED/,
		)
		assert.deepEqual(await client.action(api.operationTools.invoke, { key, payload }), unknown)
		assert.deepEqual(await state(key), committed)
	} finally {
		await client.mutation(internal.idempotency.authorize, { allowed: true })
	}
	const viewer = connection({ ...owner, subject: 'tool-viewer', role: 'viewer' })
	assert.deepEqual(await viewer.action(api.operationTools.invoke, { key, payload }), unknown)
	assert.deepEqual(await state(key), committed)
	for (const mode of ['audit', 'completion', 'result', 'cleanup']) {
		const failureKey = `operation-tool-${mode}`
		const unchanged = await state(failureKey)
		assert.deepEqual(
			await client.action(api.operationTools.invoke, {
				key: failureKey,
				payload: { title: 'write-before-failure' },
				mode,
			}),
			unknown,
		)
		assert.deepEqual(
			await state(failureKey),
			unchanged,
			'Native business, audit and receipt rollback must precede the tool failure envelope',
		)
	}
	const toolFirstKey = 'operation-tool-first'
	const first = await client.action(api.operationTools.invoke, { key: toolFirstKey, payload })
	assert.equal(first._tag, 'Success')
	assert.deepEqual(
		await client.mutation(api.idempotency.save, { key: toolFirstKey, payload }),
		first.value,
	)
	const toolFirstState = await state(toolFirstKey)
	assert.equal(toolFirstState.business.length, 1)
	assert.equal(toolFirstState.audits.length, 1)
	assert.equal(toolFirstState.receipts.length, 1)
	const note = await client.mutation(api.crud.create, { title: 'query-public-title' })
	const queryState = () => client.query(internal.crud.state, { id: note.id })
	const stored = await queryState()
	assert.equal(
		stored.note.secret,
		'server-private',
		'Private storage exists behind the public query',
	)
	const publicNote = await client.query(api.operationTools.getNote, { id: note.id })
	assert.deepEqual(publicNote, { title: 'query-public-title' })
	assert.deepEqual(Object.keys(publicNote), ['title'])
	assert.deepEqual(await client.action(api.operationTools.invokeQuery, { id: note.id }), {
		_tag: 'Success',
		value: publicNote,
	})
	const wrongTable = await client.mutation(api.crud.createOther, {})
	for (const id of ['not-a-convex-id', wrongTable]) {
		await assert.rejects(
			client.query(api.operationTools.getNote, { id }),
			/ArgumentValidationError/,
		)
		assert.deepEqual(await client.action(api.operationTools.invokeQuery, { id }), unknown)
		assert.deepEqual(await queryState(), stored, 'Invalid query IDs cannot change persisted state')
	}
	await assert.rejects(
		viewer.query(api.operationTools.getNote, { id: note.id }),
		/OPERATION_TOOL_QUERY_DENIED/,
	)
	assert.deepEqual(await viewer.action(api.operationTools.invokeQuery, { id: note.id }), unknown)
	const unauthenticated = new ConvexHttpClient(`http://127.0.0.1:${port}`)
	await assert.rejects(
		unauthenticated.query(api.operationTools.getNote, { id: note.id }),
		/authenticated|UNAUTHENTICATED/i,
	)
	assert.deepEqual(
		await unauthenticated.action(api.operationTools.invokeQuery, { id: note.id }),
		unknown,
	)
	const foreign = connection({ ...owner, org_id: 'foreign-tool-tenant' })
	assert.equal(await foreign.query(api.operationTools.getNote, { id: note.id }), null)
	assert.deepEqual(await foreign.action(api.operationTools.invokeQuery, { id: note.id }), {
		_tag: 'Success',
		value: null,
	})
	await assert.rejects(
		client.query(api.operationTools.getNote, { id: note.id, tenant: 'foreign-tool-tenant' }),
		/ArgumentValidationError/,
	)
	assert.deepEqual(
		await client.action(api.operationTools.invokeQuery, {
			id: note.id,
			tenant: 'foreign-tool-tenant',
		}),
		unknown,
	)
	assert.deepEqual(
		await queryState(),
		stored,
		'Query tools must leave business, triggers and audit unchanged',
	)
	for (const composite of [false, true]) {
		const failureKey = `operation-tool-declared-${composite}`
		assert.deepEqual(await client.query(internal.functions.read, { key: failureKey }), [])
		assert.deepEqual(
			await client.action(api.operationTools.invokeDeclaredFailure, { key: failureKey, composite }),
			composite
				? unknown
				: {
						_tag: 'DeclaredFailure',
						version: 1,
						code: 'DENIED',
						message: 'Operation denied',
						details: { key: failureKey },
					},
		)
		assert.deepEqual(
			await client.query(internal.functions.read, { key: failureKey }),
			[],
			'Declared and composite failure projection must follow native mutation rollback',
		)
	}
	console.log(
		'Native operation tools passed: direct/tool DTO, audit and receipt parity, raw input transform once, forged authority rejection, current authorization and rollback before safe failure envelopes; selected secured query public projection, invalid and wrong-table native ID rejection, denied/unauthenticated parity and tenant isolation',
	)
}
let deadline
try {
	await Promise.race([
		verify(),
		new Promise((_, reject) => {
			deadline = setTimeout(
				() => reject(new Error('Native operation tool verification timed out')),
				60000,
			)
		}),
	])
} finally {
	clearTimeout(deadline)
}
