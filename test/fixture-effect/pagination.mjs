import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ConvexClient } from 'convex/browser'
import { api } from './convex/_generated/api.js'

const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
const port = Number(process.argv[2])
assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536)
const require = createRequire(import.meta.url)
const WebSocket = require(
	require.resolve('ws', { paths: [require.resolve('convex/package.json')] }),
)
const client = new ConvexClient(`http://127.0.0.1:${port}`, { webSocketConstructor: WebSocket })
client.setAdminAuth(config.adminKey, {
	issuer: 'https://pagination.test.invalid',
	subject: 'pagination-owner',
	org_id: 'pagination-tenant',
	role: 'owner',
})
let unsubscribe
let latest
let failure
let pending
function settle() {
	if (!pending) return
	if (failure) pending.reject(failure)
	else if (latest && pending.accept(latest)) pending.resolve(latest)
	else return
	clearTimeout(pending.timer)
	pending = undefined
}
function nextPage(accept) {
	assert.equal(pending, undefined, 'Only one subscription observation may be pending')
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending = undefined
			reject(new Error('Native pagination subscription observation timed out'))
		}, 25000)
		pending = { accept, resolve, reject, timer }
		settle()
	})
}
async function verifyPagination() {
	await client.mutation(api.crud.create, { title: 'initial-a' })
	await client.mutation(api.crud.create, { title: 'initial-b' })
	unsubscribe = client.onUpdate(
		api.crud.list,
		{ numItems: 2, cursor: null },
		(page) => {
			latest = page
			settle()
		},
		(error) => {
			failure = error
			settle()
		},
	)
	const initial = await nextPage((page) => page.page.length === 2)
	console.log('Native pagination: initial secured page observed')
	assert.deepEqual(initial.page, [{ title: 'initial-b' }, { title: 'initial-a' }])
	await client.mutation(api.crud.create, { title: 'inserted-in-range' })
	const grown = await nextPage((page) => page.page.some((row) => row.title === 'inserted-in-range'))
	assert.equal(grown.page.length, 3, 'A subscribed range may grow beyond its initial request size')
	assert.deepEqual(grown.page, [
		{ title: 'inserted-in-range' },
		{ title: 'initial-b' },
		{ title: 'initial-a' },
	])
	for (const title of ['inserted-4', 'inserted-5', 'inserted-6']) {
		await client.mutation(api.crud.create, { title })
	}
	const recommended = await nextPage(
		(page) =>
			page.pageStatus === 'SplitRecommended' && page.page.some((row) => row.title === 'inserted-6'),
	)
	assert.match(recommended.splitCursor, /^/)
	const completeRange = [
		{ title: 'inserted-6' },
		{ title: 'inserted-5' },
		{ title: 'inserted-4' },
		{ title: 'inserted-in-range' },
		{ title: 'initial-b' },
		{ title: 'initial-a' },
	]
	assert.deepEqual(recommended.page, completeRange, 'Reactive ranges remain complete until split')
	const helperInitial = await client.query(api.crud.listPaginated, {
		paginationOpts: { numItems: 2, cursor: null, id: 1 },
	})
	assert.deepEqual(helperInitial.page, [{ title: 'inserted-6' }, { title: 'inserted-5' }])
	const helperRange = await client.query(api.crud.listPaginated, {
		paginationOpts: {
			numItems: 2,
			cursor: null,
			id: 2,
			endCursor: initial.continueCursor,
			maximumRowsRead: 1000,
		},
	})
	assert.equal(helperRange.pageStatus, 'SplitRecommended')
	assert.match(helperRange.splitCursor, /^/)
	assert.deepEqual(helperRange.page, completeRange)
	const split = await client.query(api.crud.listPaginated, {
		paginationOpts: { numItems: 2, cursor: null, id: 3, endCursor: helperRange.splitCursor },
	})
	const remainder = await client.query(api.crud.listPaginated, {
		paginationOpts: {
			numItems: 2,
			cursor: helperRange.splitCursor,
			id: 4,
			endCursor: helperRange.continueCursor,
		},
	})
	assert.ok(split.page.length > 0)
	assert.ok(split.page.length < completeRange.length)
	assert.ok(remainder.page.length > 0)
	assert.ok(remainder.page.length < completeRange.length)
	assert.deepEqual(
		[...split.page, ...remainder.page],
		completeRange,
		'Split ranges have no gaps or duplicates',
	)
	console.log(
		'Native pagination passed: journaled growth, native split recommendation, helper id/endCursor, gapless split ranges, and server read-budget precedence',
	)
}
let deadline
try {
	await Promise.race([
		verifyPagination(),
		new Promise((_, reject) => {
			deadline = setTimeout(
				() => reject(new Error('Native pagination verification timed out')),
				60000,
			)
		}),
	])
} finally {
	clearTimeout(deadline)
	unsubscribe?.()
	if (pending) clearTimeout(pending.timer)
	await client.close()
}
