import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ConvexHttpClient } from 'convex/browser'
import { api, internal } from './convex/_generated/api.js'

const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
const port = Number(process.argv[2])
assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536)
const owner = {
	issuer: 'https://action-validation.test.invalid',
	subject: 'action-validation-owner',
	org_id: 'action-validation-tenant',
	role: 'owner',
}
const client = new ConvexHttpClient(`http://127.0.0.1:${port}`)
client.setAdminAuth(config.adminKey, owner)
const proof = (key) => client.query(internal.actionValidation.proof, { key })

async function verify() {
	const key = randomUUID()
	const note = await client.mutation(api.crud.create, { title: 'native-action-public-title' })
	const wrongTable = await client.mutation(api.crud.createOther, {})
	assert.match(wrongTable, /\S+/, 'Wrong-table control must be a real Convex string ID')
	assert.notEqual(wrongTable, note.id)
	const noteState = () => client.query(internal.crud.state, { id: note.id })
	const otherState = () => client.query(internal.crud.otherState, { id: wrongTable })
	assert.deepEqual(await proof(key), [], 'The isolated handler probe must start empty')

	for (const id of [wrongTable, 'not-a-native-action-id']) {
		const before = await proof(key)
		assert.deepEqual(before, [], 'Each invalid invocation must begin without handler execution')
		const beforeNote = await noteState()
		const beforeOther = await otherState()
		await assert.rejects(client.action(api.actionValidation.readNote, { id, key }), (error) => {
			assert.ok(error instanceof Error)
			assert.match(error.message, /ArgumentValidationError/)
			assert.match(error.message, /Path: \.id/)
			assert.match(error.message, /v\.id\("crudNotes"\)/)
			return true
		})
		assert.deepEqual(
			await proof(key),
			before,
			'Outer native action rejection must precede the independently committed domain probe',
		)
		assert.deepEqual(await noteState(), beforeNote)
		assert.deepEqual(await otherState(), beforeOther)
	}

	const beforeSuccess = await proof(key)
	assert.deepEqual(beforeSuccess, [])
	const beforeNote = await noteState()
	const beforeOther = await otherState()
	const result = await client.action(api.actionValidation.readNote, { id: note.id, key })
	assert.deepEqual(result, { title: 'native-action-public-title' })
	assert.deepEqual(Object.keys(result), ['title'])
	assert.deepEqual(await proof(key), [...beforeSuccess, 'domain'], 'Valid ID executes domain once')
	assert.deepEqual(await noteState(), beforeNote)
	assert.deepEqual(await otherState(), beforeOther)
	console.log(
		'Native action validation passed: real wrong-table and malformed string IDs rejected by the outer native action validator before persisted domain execution; valid same-table control executes once and returns only the public title DTO',
	)
}

let deadline
try {
	await Promise.race([
		verify(),
		new Promise((_, reject) => {
			deadline = setTimeout(
				() => reject(new Error('Native action validation verification timed out')),
				60000,
			)
		}),
	])
} finally {
	clearTimeout(deadline)
}
