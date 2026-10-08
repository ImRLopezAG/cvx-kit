import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ConvexHttpClient } from 'convex/browser'
import { ConvexError } from 'convex/values'
import { defineErrorContract } from 'cvx-kit/errors'
import { z } from 'zod'
import { api, internal } from './convex/_generated/api.js'

const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
const port = Number(process.argv[2])
assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536)
const owner = {
	issuer: 'https://async-domain.test.invalid',
	subject: 'async-domain-owner',
	org_id: 'async-domain-tenant',
	role: 'owner',
}
function connection(identity = owner) {
	const client = new ConvexHttpClient(`http://127.0.0.1:${port}`)
	client.setAdminAuth(config.adminKey, identity)
	return client
}
const client = connection()
const errors = defineErrorContract({
	MISSING: { message: 'Note missing', details: { id: z.string() } },
	AFTER_PATCH: { message: 'Rename rejected after patch', details: { id: z.string() } },
})
const state = (id) => client.query(internal.crud.state, { id })
const proof = (id) => client.query(internal.asyncDomain.proof, { id })
async function declaredRejection(invocation, code, id) {
	await assert.rejects(invocation, (error) => {
		assert.ok(error instanceof ConvexError, 'Failure must cross the native Convex boundary')
		const decoded = errors.decode(error.data)
		assert.deepEqual(decoded, {
			_tag: 'DeclaredFailure',
			version: 1,
			code,
			message: code === 'MISSING' ? 'Note missing' : 'Rename rejected after patch',
			details: { id },
		})
		assert.deepEqual(Object.keys(decoded.details), ['id'])
		return true
	})
}

async function verify() {
	const { id } = await client.mutation(api.crud.create, { title: 'before-async-rename' })
	const before = await state(id)
	assert.deepEqual(await proof(id), [])
	const renamed = await client.mutation(api.asyncDomain.rename, { id, title: '  MiXeD Title  ' })
	assert.deepEqual(renamed, { title: 'mixed title' })
	assert.deepEqual(Object.keys(renamed), ['title'])
	assert.deepEqual(await client.query(api.crud.get, { id }), renamed)
	const committed = await state(id)
	assert.equal(committed.note.title, 'mixed title')
	assert.equal(committed.note.secret, before.note.secret)
	assert.equal(committed.note.owner, owner.subject)
	assert.equal(committed.note.tenant, owner.org_id)
	assert.deepEqual(committed.history, before.history)
	assert.deepEqual(committed.audits, [
		...before.audits,
		{ operation: 'asyncDomain.rename', actor: owner.subject },
	])
	const traces = await proof(id)
	assert.equal(traces.length, 1)
	assert.deepEqual(JSON.parse(traces[0]), {
		transforms: 1,
		events: ['decode', 'permission', 'handler:mixed title', 'patch', 'audit'],
	})
	await declaredRejection(
		client.mutation(api.asyncDomain.rename, {
			id,
			title: '  Must Roll Back  ',
			failAfterPatch: true,
		}),
		'AFTER_PATCH',
		id,
	)
	assert.deepEqual(await state(id), committed, 'Declared failure must roll back patch and audit')
	assert.deepEqual(await proof(id), traces, 'Rejected invocation cannot commit a success trace')
	const viewer = connection({ ...owner, role: 'viewer' })
	await assert.rejects(
		viewer.mutation(api.asyncDomain.rename, { id, title: 'denied' }),
		(error) => {
			assert.ok(error instanceof ConvexError)
			assert.deepEqual(error.data, { _tag: 'UnknownFailure', version: 1 })
			return true
		},
	)
	assert.deepEqual(await state(id), committed)
	assert.deepEqual(await proof(id), traces)
	const unauthenticated = new ConvexHttpClient(`http://127.0.0.1:${port}`)
	await assert.rejects(
		unauthenticated.mutation(api.asyncDomain.rename, { id, title: 'unauthenticated' }),
		/authenticated|UNAUTHENTICATED/i,
	)
	const foreign = connection({ ...owner, org_id: 'foreign-async-domain-tenant' })
	await declaredRejection(
		foreign.mutation(api.asyncDomain.rename, { id, title: 'foreign' }),
		'MISSING',
		id,
	)
	const otherOwner = connection({ ...owner, subject: 'another-async-domain-owner' })
	await declaredRejection(
		otherOwner.mutation(api.asyncDomain.rename, { id, title: 'another-owner' }),
		'MISSING',
		id,
	)
	const wrongTable = await client.mutation(api.crud.createOther, {})
	for (const invalidId of ['not-a-native-id', wrongTable]) {
		await assert.rejects(
			client.mutation(api.asyncDomain.rename, { id: invalidId, title: 'invalid' }),
			/ArgumentValidationError/,
		)
	}
	await assert.rejects(
		client.mutation(api.asyncDomain.rename, { id, title: 'forged', tenant: 'forged' }),
		/ArgumentValidationError/,
	)
	assert.deepEqual(await state(id), committed)
	assert.deepEqual(await proof(id), traces)
	// A separate invocation proves the counter is local rather than accumulated globally.
	const second = await client.mutation(api.crud.create, { title: 'second-before' })
	assert.deepEqual(
		await client.mutation(api.asyncDomain.rename, { id: second.id, title: '  SECOND  ' }),
		{ title: 'second' },
	)
	const secondTraces = await proof(second.id)
	assert.equal(secondTraces.length, 1)
	assert.deepEqual(JSON.parse(secondTraces[0]), {
		transforms: 1,
		events: ['decode', 'permission', 'handler:second', 'patch', 'audit'],
	})
	assert.deepEqual(await client.query(api.crud.get, { id: second.id }), { title: 'second' })
	console.log(
		'Native async domain passed: async decoder once before permission and injected handler, secured native patch and audit, exact public title DTO, independent persistence, declared ConvexError decoding after rollback, current role/owner/tenant enforcement and native ID validation',
	)
}
let deadline
try {
	await Promise.race([
		verify(),
		new Promise((_, reject) => {
			deadline = setTimeout(
				() => reject(new Error('Native async domain verification timed out')),
				60000,
			)
		}),
	])
} finally {
	clearTimeout(deadline)
}
